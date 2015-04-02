/*
    Copyright (c) 2011-2012, Loïc Hoguin <essen@ninenines.eu>

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted, provided that the above
    copyright notice and this permission notice appear in all copies.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

/**
    Bullet is a client-side javascript library AND server-side Cowboy handler
    to manage continuous streaming. It selects the proper transport in a fully
    automated way and makes sure to always reconnect to the server on any
    disconnect. You only need to handle sending messages, receiving them,
    and managing the heartbeat of the stream.

    Usage: $.bullet(url);

    Then you can register one of the 4 event handlers:
    onopen, onmessage, onclose, onheartbeat.

    onopen is called once right after starting the bullet stream.
    onmessage is called once for each message receveid.
    onclose is called once right after you voluntarily close the socket.
    onheartbeat is called once every few seconds to allow you to easily setup
    a ping/pong mechanism.
*/


(function($){$.extend({bullet: function(url, options){
    'use strict';

    var CONNECTING = 0;
    var OPEN = 1;
    var CLOSING = 2;
    var CLOSED = 3;
    var httpURL = url.replace('ws:', 'http:').replace('wss:', 'https:');
    var connectionId = null;

    if (url === httpURL) {
        if (options === undefined) {
            options = {'disableWebSocket': true};
        }
        else {
            options.disableWebSocket = true;
        }
    }

    var xhrSend = function(data){
        /**
            Send a message using ajax. Used for both the
            eventsource and xhrPolling transports.
         */
        if (this.readyState !== CONNECTING && this.readyState !== OPEN){
            return false;
        }

        var self = this;
        var headers = {'X-Socket-Transport': 'xhrPolling'};
        if (connectionId) {
            headers['Connection-id'] = connectionId;
        }
        $.ajax({
            async: false,
            cache: false,
            type: 'POST',
            url: httpURL,
            data: data,
            dataType: 'text',
            contentType: 'application/x-www-form-urlencoded; charset=utf-8',
            headers: headers,
            success: function(data){
                if (data && data.length !== 0){
                    self.onmessage({'data': data});
                }
            }
        });

        return true;
    };

    var transports = {
        /**
            The websocket transport is disabled for Firefox 6.0 because it
            causes a crash to happen when the connection is closed.
            @see https://bugzilla.mozilla.org/show_bug.cgi?id=662554
        */
        websocket: function(){
            var transport = null;

            if (options !== undefined && options.disableWebSocket) {
                return false;
            }

            if (window.WebSocket){
                transport = window.WebSocket;
            }

            if (window.MozWebSocket && navigator.userAgent.indexOf('Firefox/6.0') === -1){
                transport = window.MozWebSocket;
            }

            if (transport){
                return {'heart': true, 'transport': transport};
            }

            return null;
        },

        eventsource: function(){
            if (options !== undefined && options.disableEventSource) {
                return false;
            }

            if (!window.EventSource){
                return false;
            }

            var source = new window.EventSource(httpURL);

            source.onopen = function () {
                fake.readyState = OPEN;
                fake.onopen();
            };

            source.onmessage = function (event) {
                fake.onmessage(event);
            };

            source.onerror = function () {
                source.close(); // bullet will handle reconnects
                source = undefined;
                fake.onerror();
            };

            var fake = {
                readyState: CONNECTING,
                send: xhrSend,
                close: function(){
                    fake.readyState = CLOSED;
                    source.close();
                    source = undefined;
                    fake.onclose();
                }
            };

            return {'heart': false, 'transport': function(){ return fake; }};
        },

        xhrPolling: function(){
            if (options !== undefined && options.disableXHRPolling) {
                return false;
            }

            var timeout;
            var xhr = null;

            var fake = {
                readyState: CONNECTING,
                send: xhrSend,
                close: function(){
                    this.readyState = CLOSED;
                    if (xhr){
                        xhr.abort();
                        xhr = null;
                    }
                    clearTimeout(timeout);
                    fake.onclose();
                },
                onopen: function(){},
                onmessage: function(){},
                onerror: function(){},
                onclose: function(){}
            };

            function poll(){
                var headers = {'X-Socket-Transport': 'xhrPolling'};
                if (connectionId) {
                    headers['Connection-id'] = connectionId;
                }
                xhr = $.ajax({
                    type: 'GET',
                    cache: false,
                    url: httpURL,
                    dataType: 'text',
                    data: {},
                    headers: headers,
                    success: function(data, textStatus, request){
                        xhr = null;
                        if (data === 'connection-id') {
                            connectionId = request.getResponseHeader('connection-id');
                            // soft reopen, call to initialize connection again
                            stream.onopen();
                        }
                        if (fake.readyState === CONNECTING){
                            fake.readyState = OPEN;
                            fake.onopen(fake);
                        }
                        // Connection might have closed without a response body
                        if (data && data.length !== 0 && data !== 'connection-id' && data !== 'pong'){
                            fake.onmessage({'data': data});
                        }
                        if (fake.readyState === OPEN){
                            nextPoll();
                        }
                    },
                    error: function(xhr){
                        xhr = null;
                        fake.onerror();
                    }
                });
            }

            function nextPoll(){
                timeout = setTimeout(function(){poll();}, 100);

            }

            nextPoll();

            return {'heart': false, 'transport': function(){ return fake; }};
        }
    };

    var tn = 0;
    function next(){
        var c = 0;

        for (var f in transports){
            if (tn === c){
                var t = transports[f]();
                if (t){
                    var ret = new t.transport(url);
                    ret.heart = t.heart;
                    return ret;
                }

                tn++;
            }

            c++;
        }

        return false;
    }

    var stream = new function(){
        var isClosed = true;
        var readyState = CLOSED;
        var heartbeat;
        var delay = 80;
        var delayDefault = 80;
        var delayMax = 10000;

        var transport;
        function init(){
            isClosed = false;
            readyState = CONNECTING;
            transport = next();

            if (!transport){
                // Hard disconnect, inform the user and retry later
                delay = delayDefault;
                tn = 0;
                if (stream) {
                    stream.ondisconnect();
                }
                setTimeout(function(){init();}, delayMax);
                return false;
            }

            transport.onopen = function(){
                // We got a connection, reset the poll delay
                delay = delayDefault;

                if (transport.heart){
                    heartbeat = setInterval(function(){stream.onheartbeat();}, 20000);
                }

                if (readyState !== OPEN){
                    readyState = OPEN;
                    stream.onopen();
                }
            };
            transport.onclose = function(){
                // Firefox 13.0.1 sends 2 close events.
                // Return directly if we already handled it
                // or we are closed
                if (isClosed || readyState === CLOSED){
                    return;
                }

                transport = null;
                clearInterval(heartbeat);

                if (readyState === CLOSING){
                    readyState = CLOSED;
                    transport = false;
                    stream.onclose();
                } else{
                    // Close happened on connect, select next transport
                    if (readyState === CONNECTING){
                        tn++;
                    }

                    delay *= 2;
                    if (delay > delayMax){
                        delay = delayMax;
                    }

                    isClosed = true;

                    setTimeout(function(){
                        init();
                    }, delay);
                }
            };
            transport.onerror = transport.onclose;
            transport.onmessage = function(e){
                stream.onmessage(e);
            };
        }
        init();

        this.onopen = function(){};
        this.onmessage = function(){};
        this.ondisconnect = function(){};
        this.onclose = function(){};
        this.onheartbeat = function(){};

        this.setURL = function(newURL){
            url = newURL;
        };
        this.send = function(data){
            if (transport){
                var ret = transport.send(data);
                return (ret === undefined) || ret;
            } else{
                return false;
            }
        };
        this.close = function(){
            readyState = CLOSING;
            if (transport){
                transport.close();
            }
        };
    };

    return stream;
}});})(jQuery);

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
        if (this.onPresence) {
            this.onPresence({channel: payload.channel, 
                            subscribers: payload.subscribers});
        }
    };

    var processInfo = function(payload) {
        if (this.onInfo) {
            this.onInfo(payload);
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
