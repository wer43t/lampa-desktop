/**
 * Voice-over selection for torrents played in Lampa's built-in player.
 *
 * Chromium cannot decode AC3 / E-AC3 / DTS / TrueHD, so such tracks (often the dubbed
 * ones) silently disappear from the player. When TorrServer is a GStreamer build
 * (TorrServer-gst-*), it can remux a chosen audio track to AAC as HLS:
 *   /gst/<hash>/master.m3u8?index=<file>&audio=<n>
 * Lampa itself always asks for audio=0. Before a torrent file starts we probe its
 * tracks; with several of them the user picks one (preferred language highlighted),
 * and the pick is remembered per torrent so the next episodes start without asking.
 * If the pick is the first track and natively playable, the direct stream is kept
 * (no transcoding); otherwise the URL is switched to the GStreamer stream.
 *
 * The choice can be changed from the long-press menu of a file ("Выбрать озвучку").
 * Runs in the page (main world). Setting: "desktop_audio_lang" (see desktop-settings.js).
 */
(function () {
  if (window.__desktopAudioLoaded) return; // loaded both locally and as a plugin
  window.__desktopAudioLoaded = true;

  var CHOICE_KEY = 'desktop_audio_choice';
  var MAX_CHOICES = 200;
  var PROBE_TIMEOUT_MS = 40000;
  var ECHO_RETRY_MS = 60000;

  var LANGS = {
    ru: ['ru', 'rus', 'russian'],
    uk: ['uk', 'ukr', 'ukrainian'],
    en: ['en', 'eng', 'english']
  };

  var LANG_NAMES = {
    ru: 'русский', rus: 'русский', uk: 'украинский', ukr: 'украинский',
    en: 'английский', eng: 'английский', ja: 'японский', jpn: 'японский',
    de: 'немецкий', ger: 'немецкий', fr: 'французский', fre: 'французский',
    es: 'испанский', spa: 'испанский', it: 'итальянский', ita: 'итальянский',
    ko: 'корейский', kor: 'корейский', zh: 'китайский', chi: 'китайский'
  };

  // GStreamer caps Chromium can't play natively.
  var UNSUPPORTED = /^audio\/x-(ac3|eac3|dts|true-hd|truehd|private|mlp)/i;

  var gst = { ok: false, checked: 0 };
  var PROBE_KEY = 'desktop_audio_probe';
  var MAX_PROBES = 300;
  var PREFETCH_DELAY_MS = 15000;
  var probes = {};      // "<hash>:<file>" -> probe json (memory copy of the stored ones)
  var prefetchNet;      // separate request so a background probe never cancels a real one
  var prefetchTimer;
  var forceAsk = {};    // torrent hash -> true: show the picker even if a choice is stored
  var network;

  function whenReady(cb) {
    if (window.Lampa && Lampa.Player && Lampa.Player.listener && Lampa.Torserver &&
        Lampa.Storage && Lampa.Reguest && Lampa.Loading && Lampa.Select && Lampa.Controller) return cb();
    setTimeout(function () { whenReady(cb); }, 200);
  }

  function preferred() {
    return Lampa.Storage.get('desktop_audio_lang', 'ru') || 'ru';
  }

  // External players (VLC on desktop, the Android system player) decode AC3 and switch
  // tracks themselves. On Android the core sends torrents to the system player unless its
  // own GStreamer mode is on, so only step in then.
  function usesExternalPlayer(data) {
    if (Lampa.Platform && Lampa.Platform.is('android') && !Lampa.Torserver.gstWork()) return true;
    if (data.launch_player === 'lampa' || data.launch_player === 'inner') return false;
    return Lampa.Storage.field('player_torrent') !== 'inner';
  }

  // Direct stream  <base>/stream/<name>?link=<hash>&index=<id>&play
  // or the core's own GStreamer stream  <base>/gst/<hash>/master.m3u8?index=<id>&audio=0
  function parseStream(url) {
    var base = Lampa.Torserver.url();
    if (typeof url !== 'string' || !base || url.indexOf(base) !== 0) return null;
    var index = (url.match(/[?&]index=(\d+)/) || [])[1];
    var gst = url.match(/\/gst\/([0-9a-f]{40})\/master\.m3u8\?/i);
    if (gst) return index ? { base: base, hash: gst[1].toLowerCase(), index: index, gst: true } : null;
    if (!/\/stream\/[^?]*\?/.test(url)) return null;
    var hash = (url.match(/[?&]link=([0-9a-f]{40})\b/i) || [])[1];
    return hash && index ? { base: base, hash: hash.toLowerCase(), index: index } : null;
  }

  function gstUrl(src, audio) {
    return src.base + '/gst/' + src.hash + '/master.m3u8?index=' + src.index + '&audio=' + audio;
  }

  // --- tracks ----------------------------------------------------------------

  function audioTracks(probe) {
    return (probe && probe.Tracks || []).filter(function (t) { return t.Type === 'audio'; });
  }

  function caps(track) {
    return track.CapsName || String(track.Codec || '').split(',')[0];
  }

  function codecName(track) {
    var c = caps(track).toLowerCase();
    if (c === 'audio/mpeg') return /mpegversion=\(int\)(2|4)/.test(track.Codec || '') ? 'AAC' : 'MP3';
    var m = c.match(/^audio\/x-(.+)$/);
    return m ? m[1].toUpperCase() : c;
  }

  function isNative(track) {
    return !UNSUPPORTED.test(caps(track));
  }

  function matchesLang(track, lang) {
    var names = LANGS[lang] || [lang];
    var code = String(track.Language || '').toLowerCase();
    if (names.indexOf(code) >= 0) return true;
    return lang === 'ru' && /рус|дубл/i.test(track.Title || '');
  }

  function preferredTrack(tracks, lang) {
    return tracks.filter(function (t) { return matchesLang(t, lang); })[0] || tracks[0];
  }

  function label(track, n) {
    return String(track.Title || '').trim() || ('Дорожка ' + (n + 1));
  }

  function details(track) {
    var parts = [];
    var code = String(track.Language || '').toLowerCase();
    if (code) parts.push(LANG_NAMES[code] || code);
    parts.push(codecName(track) + (track.Channels ? ' ' + track.Channels + 'ch' : ''));
    if (!isNative(track)) parts.push('перекодируется');
    return parts.join(' · ');
  }

  // -1 = keep the direct stream, otherwise the GStreamer audio index to use.
  function streamAudio(tracks, pick) {
    return pick === tracks[0] && isNative(pick) ? -1 : pick.Index;
  }

  // --- remembered choice per torrent ------------------------------------------

  function choices() {
    var all = Lampa.Storage.get(CHOICE_KEY, '{}');
    return all && typeof all === 'object' ? all : {};
  }

  function rememberChoice(hash, track) {
    var all = choices();
    all[hash] = { index: track.Index, lang: track.Language || '', title: track.Title || '', updated: Date.now() };
    var keys = Object.keys(all);
    if (keys.length > MAX_CHOICES) {
      keys.sort(function (a, b) { return (all[a].updated || 0) - (all[b].updated || 0); });
      keys.slice(0, keys.length - MAX_CHOICES).forEach(function (k) { delete all[k]; });
    }
    Lampa.Storage.set(CHOICE_KEY, all);
  }

  // The same track in another episode of the release: by title, else by position + language.
  function rememberedTrack(hash, tracks) {
    var c = choices()[hash];
    if (!c) return null;
    if (c.title) {
      var byTitle = tracks.filter(function (t) { return t.Title === c.title && (t.Language || '') === c.lang; })[0];
      if (byTitle) return byTitle;
    }
    return tracks.filter(function (t) { return t.Index === c.index && (t.Language || '') === c.lang; })[0] || null;
  }

  // --- flow --------------------------------------------------------------------

  function checkGst(done) {
    if (gst.ok || Date.now() - gst.checked < ECHO_RETRY_MS) return done(gst.ok);
    gst.checked = Date.now();
    network.timeout(5000);
    network.silent(Lampa.Torserver.url() + '/gst/echo', function (json) {
      gst.ok = !!(json && json.gstreamer && json.gstreamer.works);
      done(gst.ok);
    }, function () {
      gst.ok = false;
      done(false);
    });
  }

  // Tracks of a file never change, so probes are kept across restarts (only the fields we use).
  function storedProbe(key) {
    var all = Lampa.Storage.get(PROBE_KEY, '{}');
    var hit = all && typeof all === 'object' ? all[key] : null;
    return hit && hit.tracks ? { Tracks: hit.tracks } : null;
  }

  function storeProbe(key, probe) {
    var all = Lampa.Storage.get(PROBE_KEY, '{}');
    if (!all || typeof all !== 'object') all = {};
    all[key] = {
      u: Date.now(),
      tracks: (probe.Tracks || []).filter(function (t) { return t.Type === 'audio'; }).map(function (t) {
        return {
          Type: t.Type, Index: t.Index, CapsName: t.CapsName, Codec: String(t.Codec || '').slice(0, 120),
          Language: t.Language, Title: t.Title, Channels: t.Channels
        };
      })
    };
    var keys = Object.keys(all);
    if (keys.length > MAX_PROBES) {
      keys.sort(function (a, b) { return (all[a].u || 0) - (all[b].u || 0); });
      keys.slice(0, keys.length - MAX_PROBES).forEach(function (k) { delete all[k]; });
    }
    Lampa.Storage.set(PROBE_KEY, all);
  }

  function loadProbe(src, done, request) {
    var key = src.hash + ':' + src.index;
    if (!probes[key]) probes[key] = storedProbe(key);
    if (probes[key]) return done(probes[key]);
    request = request || network;

    var finished = false;
    var finish = function (probe) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (probe && probe.Tracks) {
        probes[key] = probe;
        storeProbe(key, probe);
      }
      done(probe);
    };
    var timer = setTimeout(function () { finish(null); }, PROBE_TIMEOUT_MS + 2000);

    checkGst(function (ok) {
      if (!ok) return finish(null);
      request.timeout(PROBE_TIMEOUT_MS);
      request.silent(src.base + '/gst/' + src.hash + '/probe?index=' + src.index, finish, function () {
        finish(null);
      });
    });
  }

  // While an episode plays, probe the next one so auto-advance doesn't wait for it.
  function onStart(data) {
    clearTimeout(prefetchTimer);
    if (!data || !data.torrent_hash || preferred() === 'off' || usesExternalPlayer(data)) return;
    prefetchTimer = setTimeout(function () {
      var list = Lampa.PlayerPlaylist.get() || [];
      var current = String(data.timeline && data.timeline.hash || '');
      var at = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].timeline && String(list[i].timeline.hash) === current) { at = i; break; }
      }
      var next = at >= 0 ? list[at + 1] : null;
      var src = next && parseStream(next.url);
      if (src) loadProbe(src, function () {}, prefetchNet);
    }, PREFETCH_DELAY_MS);
  }

  function pickTrack(tracks, lang, onPick, onCancel) {
    var suggested = preferredTrack(tracks, lang);
    var enabled = Lampa.Controller.enabled().name;
    Lampa.Select.show({
      title: 'Озвучка',
      items: tracks.map(function (t, n) {
        return { title: label(t, n), subtitle: details(t), selected: t === suggested, track: t };
      }),
      onSelect: function (item) {
        Lampa.Controller.toggle(enabled);
        onPick(item.track);
      },
      onBack: function () {
        Lampa.Controller.toggle(enabled);
        onCancel();
      }
    });
  }

  function onCreate(e) {
    var data = e.data;
    if (!data || data.__desktop_audio || !data.torrent_hash) return;

    var lang = preferred();
    if (lang === 'off' || usesExternalPlayer(data)) return;

    var src = parseStream(data.url);
    if (!src) return;

    e.abort();
    data.__desktop_audio = true;

    var cancelled = false;
    var start = function (audio) {
      if (audio >= 0) {
        data.url = gstUrl(src, audio);
        data.hls_manifest_timeout = 60000;
      }
      Lampa.Player.play(data);
      delete data.__desktop_audio;
    };

    Lampa.Loading.start(function () {
      cancelled = true;
      Lampa.Loading.stop();
      delete data.__desktop_audio;
    }, 'Подбор озвучки…');

    loadProbe(src, function (probe) {
      if (cancelled) return;
      Lampa.Loading.stop();

      var tracks = audioTracks(probe);
      if (tracks.length < 2) return start(tracks.length ? streamAudio(tracks, tracks[0]) : -1);

      var remembered = !forceAsk[src.hash] && rememberedTrack(src.hash, tracks);
      if (remembered) return start(streamAudio(tracks, remembered));

      pickTrack(tracks, lang, function (track) {
        delete forceAsk[src.hash];
        rememberChoice(src.hash, track);
        start(streamAudio(tracks, track));
      }, function () {
        delete data.__desktop_audio;
      });
    });
  }

  // "Выбрать озвучку" in the long-press menu of a torrent file.
  function onTorrentFile(e) {
    if (e.type !== 'onlong' || !e.menu || !e.element || !e.item) return;
    if (preferred() === 'off' || usesExternalPlayer({})) return;
    var hash = String(e.element.torrent_hash || '').toLowerCase();
    if (!hash) return;
    var enabled = Lampa.Controller.enabled().name;
    var item = e.item;
    e.menu.push({
      title: 'Выбрать озвучку',
      onSelect: function () {
        Lampa.Controller.toggle(enabled);
        forceAsk[hash] = true;
        item.trigger('hover:enter');
      }
    });
  }

  whenReady(function () {
    network = new Lampa.Reguest();
    prefetchNet = new Lampa.Reguest();
    Lampa.Player.listener.follow('create', onCreate);
    Lampa.Player.listener.follow('start', onStart);
    Lampa.Listener.follow('torrent_file', onTorrentFile);
  });
})();
