// Shared by the share page and the pages that show a screen share (the OBS display and the
// control page). The video goes straight from the sharing browser to each viewer over WebRTC;
// the server only relays the setup: a viewer says hello, the sharer sends an offer, the viewer
// answers. Each side waits for its network candidates before sending, so that is all it takes.
(function () {
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  function gathered(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var t = setTimeout(resolve, 2000); // enough for this network; STUN may be slow or blocked
      pc.addEventListener('icegatheringstatechange', function () {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  // WebRTC sends speech-quality mono by default. The viewer asks for stereo at a music bitrate.
  function musicAudio(sdp) {
    var m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
    if (!m) return sdp;
    return sdp.replace(new RegExp('(a=fmtp:' + m[1] + ' [^\\r\\n]*)'), function (line) {
      return line.replace(/;?(stereo|sprop-stereo|maxaveragebitrate)=[^;]*/g, '') + ';stereo=1;sprop-stereo=1;maxaveragebitrate=192000';
    });
  }

  function newId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // opts: { peer, role: 'display' | 'preview', key, onStream(shareId, stream) }
  // peer must also be on the page's event stream (/events?peer=), where offers arrive.
  function ScreenViewer(opts) {
    var conns = {}; // share id -> { pc, stream, wanted, retry, idle }

    function post(body) {
      var headers = { 'Content-Type': 'application/json' };
      if (opts.key) headers['X-Key'] = opts.key;
      return fetch('/api/rtc', { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .then(function (r) { return r.ok; }, function () { return false; });
    }

    // Asks the sharer for an offer, and asks again until one arrives.
    function hello(id) {
      var c = conns[id];
      if (!c || !c.wanted) return;
      clearTimeout(c.retry);
      c.retry = setTimeout(function () { hello(id); }, 5000);
      post({ kind: 'hello', share: id, peer: opts.peer, role: opts.role }).then(function (ok) {
        if (!ok && conns[id] === c) { clearTimeout(c.retry); c.retry = setTimeout(function () { hello(id); }, 2000); }
      });
    }

    function drop(id, sayBye) {
      var c = conns[id];
      if (!c) return;
      delete conns[id];
      clearTimeout(c.retry); clearTimeout(c.idle);
      if (c.pc) c.pc.close();
      if (sayBye) post({ kind: 'bye', share: id, peer: opts.peer });
    }

    function onOffer(id, sdp) {
      var c = conns[id];
      if (!c || !sdp) return;
      clearTimeout(c.retry);
      if (c.pc) c.pc.close();
      var pc = c.pc = new RTCPeerConnection({ iceServers: ICE });
      var lost = null;
      pc.ontrack = function (e) {
        c.stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        opts.onStream(id, c.stream);
      };
      // A connection that drops is set up again. What the viewer shows keeps its last frame meanwhile.
      pc.onconnectionstatechange = function () {
        if (pc !== c.pc) return;
        var st = pc.connectionState;
        clearTimeout(lost);
        if (st === 'failed' || st === 'closed') again();
        else if (st === 'disconnected') lost = setTimeout(again, 4000);
      };
      function again() {
        if (pc !== c.pc || conns[id] !== c) return;
        pc.close();
        c.pc = null;
        hello(id);
      }
      pc.setRemoteDescription(sdp)
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription({ type: a.type, sdp: musicAudio(a.sdp) }); })
        .then(function () { return gathered(pc); })
        .then(function () {
          if (pc === c.pc) post({ kind: 'answer', share: id, peer: opts.peer, sdp: pc.localDescription });
        })
        .catch(function () { if (pc === c.pc) again(); });
    }

    return {
      // The shares this page needs now. Ones no longer needed are kept for a while, so a share
      // taken off air and straight back doesn't have to connect again.
      want: function (ids) {
        var need = {};
        ids.forEach(function (id) { if (id) need[id] = true; });
        Object.keys(need).forEach(function (id) {
          var c = conns[id];
          if (c) { clearTimeout(c.idle); c.idle = null; return; }
          conns[id] = { pc: null, stream: null, wanted: true, retry: null, idle: null };
          hello(id);
        });
        Object.keys(conns).forEach(function (id) {
          var c = conns[id];
          if (need[id] || c.idle) return;
          c.idle = setTimeout(function () { drop(id, true); }, 15000);
        });
      },
      stream: function (id) { return conns[id] ? conns[id].stream : null; },
      // The receiving side of each connected share, from the browser's own statistics.
      stats: function () {
        return Promise.all(Object.keys(conns).map(function (id) {
          var pc = conns[id].pc;
          if (!pc || pc.connectionState !== 'connected') return null;
          return pc.getStats().then(function (report) {
            var v = null, a = null, codecs = {}, pair = null;
            report.forEach(function (s) {
              if (s.type === 'inbound-rtp' && s.kind === 'video') v = s;
              if (s.type === 'inbound-rtp' && s.kind === 'audio') a = s;
              if (s.type === 'codec') codecs[s.id] = s;
              if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
            });
            if (!v) return null;
            return {
              share: id, at: v.timestamp,
              framesReceived: v.framesReceived, framesDecoded: v.framesDecoded, framesDropped: v.framesDropped,
              fps: v.framesPerSecond, width: v.frameWidth, height: v.frameHeight,
              freezeCount: v.freezeCount, freezeSeconds: v.totalFreezesDuration,
              jitterMs: v.jitterBufferEmittedCount ? v.jitterBufferDelay / v.jitterBufferEmittedCount * 1000 : undefined,
              decodeMs: v.framesDecoded ? v.totalDecodeTime / v.framesDecoded * 1000 : undefined,
              packetsLost: v.packetsLost, nacks: v.nackCount, plis: v.pliCount, bytes: v.bytesReceived,
              decoder: v.decoderImplementation, hwDecoder: v.powerEfficientDecoder,
              codec: codecs[v.codecId] ? codecs[v.codecId].mimeType.split('/')[1] : '',
              audioBytes: a ? a.bytesReceived : undefined,
              rttMs: pair && pair.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : undefined
            };
          });
        })).then(function (list) { return list.filter(Boolean); });
      },
      // An offer from the event stream: { share, kind, sdp }.
      signal: function (m) { if (m && m.kind === 'offer') onOffer(m.share, m.sdp); }
    };
  }

  window.ScreenViewer = ScreenViewer;
  window.screenShareId = newId;
  window.screenGathered = gathered;
  window.SCREEN_ICE = ICE;
})();
