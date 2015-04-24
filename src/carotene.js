function caroteneConstructor() {
    'use strict';

    var caroteneUrl = null;
    var stream = null;
    var userId = null;
    var token = null;
    var state = 'CLOSED';
    var channelsSubscribed = {};
    var onPresence = null;
    var onInfo = null;

    var doSubscribe = function(channel) {
        var message = JSON.stringify({subscribe: channel});
        stream.send(message);
    };

    var getPresence = function(message) {
        stream.send(message);
    };

    var doSetOnPresence = function(callback) {
        onPresence = callback;
    };

    var doSetOnInfo = function(callback) {
        onInfo = callback;
    };

    var doAuthenticate = function() {
        if (userId) {
            stream.send(JSON.stringify({authenticate: userId, token: token}));
        }
    };

    var subscribeToChannels = function() {
        for (var channel in channelsSubscribed) {
            doSubscribe(channel);
        }
    };

    var doPublish = function(channel, message) {
        stream.send(JSON.stringify({publish: message, channel: channel}));
    };

    var connect = function() {
        stream = $.bullet(caroteneUrl, {disableWebSocket: false, disableEventSource: true});
        stream.onopen = function(evt) { onOpen(evt); };
        stream.onclose = function(evt) { onClose(evt); };
        stream.onmessage = function(evt) { onMessagePreprocess(evt); };
        stream.onerror = function(evt) { onError(evt); };
        stream.onheartbeat = function(evt) { stream.send('ping'); };
    };

    var onOpen = function(evt) {
        state = 'OPEN';
        doAuthenticate();
        subscribeToChannels();
    };

    var onClose = function(evt) {
        state = 'CLOSED';
    };

    var onError = function(evt) {
    };

    var onMessagePreprocess = function(evt) {
        if (evt.data === 'pong') {
            return;
        }
        var payload = JSON.parse(evt.data);
        if( Object.prototype.toString.call( payload ) === '[object Array]' ) {
            for (var i =0; i < payload.length; ++i) {
                onMessage(payload[i]);
            }
        } else {
            onMessage(payload);
        }
    };

    var onMessage = function(payload) {
        if ('type' in payload) {
            switch(payload.type) {
                case 'message':
                    processMessage(payload);
                break;
                case 'presence':
                    processPresence(payload);
                break;
                case 'info':
                    processInfo(payload);
                break;
                default:
                return;
            }
        }
    };

    var processMessage = function(payload) {
        var toSend = {};
        if ('from_server' in payload && payload.fromServer === 'true') {
            toSend.fromServer = true;
        }
        if ('user_id' in payload) {
            toSend.userId = payload.user_id;
        }
        if ('user_data' in payload) {
            toSend.userData = payload.user_data;
        }
        if ('message' in payload) {
            toSend.message = JSON.parse(payload.message);
        }
        if (payload.channel in channelsSubscribed) {
            channelsSubscribed[payload.channel].onMessage(toSend);
        }
    };

    var processPresence = function(payload) {
        if (onPresence) {
            onPresence({channel: payload.channel, 
                        subscribers: payload.subscribers});
        }
    };

    var processInfo = function(payload) {
        if (onInfo) {
            onInfo(payload);
        }
    };

    return {
        init: function(config)  {
            caroteneUrl = config.caroteneUrl;
            userId = config.userId;
            connect();
        },

        subscribe: function(config) {
            var channel = config.channel;
            var onMessage = config.onMessage;
            channelsSubscribed[channel] = {
                onMessage : onMessage
            };
            if (state === 'OPEN') {
                doSubscribe(channel);
            }
        },

        publish: function(pubdata) {
            var channel = pubdata.channel;
            var message = pubdata.message;
            doPublish(channel, JSON.stringify(message));
        },

        authenticate: function(authdata) {
            userId = authdata.userId;
            token = authdata.token;
            if (state === 'OPEN') {
                doAuthenticate({userId: userId, token: token});
            }
        },

        presence: function(presencedata) {
            channel = presencedata.channel;
            var message = JSON.stringify({presence: channel});
            getPresence(message);
        },

        setOnPresence: function(callback) {
            doSetOnPresence(callback);
        },

        setOnInfo: function(callback) {
            doSetOnInfo(callback);
        }
    };
}

var Carotene = new caroteneConstructor();
