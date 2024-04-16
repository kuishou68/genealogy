module.exports = (function() {
var __MODS__ = {};
var __DEFINE__ = function(modId, func, req) { var m = { exports: {}, _tempexports: {} }; __MODS__[modId] = { status: 0, func: func, req: req, m: m }; };
var __REQUIRE__ = function(modId, source) { if(!__MODS__[modId]) return require(source); if(!__MODS__[modId].status) { var m = __MODS__[modId].m; m._exports = m._tempexports; var desp = Object.getOwnPropertyDescriptor(m, "exports"); if (desp && desp.configurable) Object.defineProperty(m, "exports", { set: function (val) { if(typeof val === "object" && val !== m._exports) { m._exports.__proto__ = val.__proto__; Object.keys(val).forEach(function (k) { m._exports[k] = val[k]; }); } m._tempexports = val }, get: function () { return m._tempexports; } }); __MODS__[modId].status = 1; __MODS__[modId].func(__MODS__[modId].req, m, m.exports); } return __MODS__[modId].m.exports; };
var __REQUIRE_WILDCARD__ = function(obj) { if(obj && obj.__esModule) { return obj; } else { var newObj = {}; if(obj != null) { for(var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) newObj[k] = obj[k]; } } newObj.default = obj; return newObj; } };
var __REQUIRE_DEFAULT__ = function(obj) { return obj && obj.__esModule ? obj.default : obj; };
__DEFINE__(1713256544525, function(require, module, exports) {
//////////////////////////////////////////
// Needle -- HTTP Client for Node.js
// Written by Tomás Pollak <tomas@forkhq.com>
// (c) 2012-2023 - Fork Ltd.
// MIT Licensed
//////////////////////////////////////////

var fs          = require('fs'),
    http        = require('http'),
    https       = require('https'),
    url         = require('url'),
    stream      = require('stream'),
    debug       = require('util').debuglog('needle'),
    stringify   = require('./querystring').build,
    multipart   = require('./multipart'),
    auth        = require('./auth'),
    cookies     = require('./cookies'),
    parsers     = require('./parsers'),
    decoder     = require('./decoder'),
    utils       = require('./utils');

//////////////////////////////////////////
// variabilia

var version     = require('../package.json').version;

var user_agent  = 'Needle/' + version;
user_agent     += ' (Node.js ' + process.version + '; ' + process.platform + ' ' + process.arch + ')';

var tls_options = 'pfx key passphrase cert ca ciphers rejectUnauthorized secureProtocol checkServerIdentity family';

// older versions of node (< 0.11.4) prevent the runtime from exiting
// because of connections in keep-alive state. so if this is the case
// we'll default new requests to set a Connection: close header.
var close_by_default = !http.Agent || http.Agent.defaultMaxSockets != Infinity;

// see if we have Object.assign. otherwise fall back to util._extend
var extend = Object.assign ? Object.assign : require('util')._extend;

// these are the status codes that Needle interprets as redirects.
var redirect_codes = [301, 302, 303, 307, 308];

//////////////////////////////////////////
// decompressors for gzip/deflate/br bodies

function bind_opts(fn, options) {
  return fn.bind(null, options);
}

var decompressors = {};

try {

  var zlib = require('zlib');

  // Enable Z_SYNC_FLUSH to avoid Z_BUF_ERROR errors (Node PR #2595)
  var zlib_options = {
    flush: zlib.Z_SYNC_FLUSH,
    finishFlush: zlib.Z_SYNC_FLUSH
  };

  var br_options = {
    flush: zlib.BROTLI_OPERATION_FLUSH,
    finishFlush: zlib.BROTLI_OPERATION_FLUSH
  };

  decompressors['x-deflate'] = bind_opts(zlib.Inflate, zlib_options);
  decompressors['deflate']   = bind_opts(zlib.Inflate, zlib_options);
  decompressors['x-gzip']    = bind_opts(zlib.Gunzip, zlib_options);
  decompressors['gzip']      = bind_opts(zlib.Gunzip, zlib_options);
  if (typeof zlib.BrotliDecompress === 'function') {
    decompressors['br']      = bind_opts(zlib.BrotliDecompress, br_options);
  }

} catch(e) { /* zlib not available */ }

//////////////////////////////////////////
// options and aliases

var defaults = {
  // data
  boundary                : '--------------------NODENEEDLEHTTPCLIENT',
  encoding                : 'utf8',
  parse_response          : 'all', // same as true. valid options: 'json', 'xml' or false/null
  proxy                   : null,

  // agent & headers
  agent                   : null,
  headers                 : {},
  accept                  : '*/*',
  user_agent              : user_agent,

  // numbers
  open_timeout            : 10000,
  response_timeout        : 0,
  read_timeout            : 0,
  follow_max              : 0,
  stream_length           : -1,

  // abort signal
  signal                  : null,

  // booleans
  compressed              : false,
  decode_response         : true,
  parse_cookies           : true,
  follow_set_cookies      : false,
  follow_set_referer      : false,
  follow_keep_method      : false,
  follow_if_same_host     : false,
  follow_if_same_protocol : false,
  follow_if_same_location : false,
  use_proxy_from_env_var  : true
}

var aliased = {
  options: {
    decode  : 'decode_response',
    parse   : 'parse_response',
    timeout : 'open_timeout',
    follow  : 'follow_max'
  },
  inverted: {}
}

// only once, invert aliased keys so we can get passed options.
Object.keys(aliased.options).map(function(k) {
  var value = aliased.options[k];
  aliased.inverted[value] = k;
});

//////////////////////////////////////////
// helpers

function keys_by_type(type) {
  return Object.keys(defaults).map(function(el) {
    if (defaults[el] !== null && defaults[el].constructor == type)
      return el;
  }).filter(function(el) { return el })
}

//////////////////////////////////////////
// the main act

function Needle(method, uri, data, options, callback) {
  // if (!(this instanceof Needle)) {
  //   return new Needle(method, uri, data, options, callback);
  // }

  if (typeof uri !== 'string')
    throw new TypeError('URL must be a string, not ' + uri);

  this.method   = method.toLowerCase();
  this.uri      = uri;
  this.data     = data;

  if (typeof options == 'function') {
    this.callback = options;
    this.options  = {};
  } else {
    this.callback = callback;
    this.options  = options;
  }

}

Needle.prototype.setup = function(uri, options) {

  function get_option(key, fallback) {
    // if original is in options, return that value
    if (typeof options[key] != 'undefined') return options[key];

    // otherwise, return value from alias or fallback/undefined
    return typeof options[aliased.inverted[key]] != 'undefined'
                ? options[aliased.inverted[key]] : fallback;
  }

  function check_value(expected, key) {
    var value = get_option(key),
        type  = typeof value;

    if (type != 'undefined' && type != expected)
      throw new TypeError(type + ' received for ' + key + ', but expected a ' + expected);

    return (type == expected) ? value : defaults[key];
  }

  //////////////////////////////////////////////////
  // the basics

  var config = {
    http_opts : {
      agent: get_option('agent', defaults.agent),
      localAddress: get_option('localAddress', undefined),
      lookup: get_option('lookup', undefined),
      signal: get_option('signal', defaults.signal)
    }, // passed later to http.request() directly
    headers   : {},
    output    : options.output,
    proxy     : get_option('proxy', defaults.proxy),
    parser    : get_option('parse_response', defaults.parse_response),
    encoding  : options.encoding || (options.multipart ? 'binary' : defaults.encoding)
  }

  keys_by_type(Boolean).forEach(function(key) {
    config[key] = check_value('boolean', key);
  })

  keys_by_type(Number).forEach(function(key) {
    config[key] = check_value('number', key);
  })

  if (config.http_opts.signal && !(config.http_opts.signal instanceof AbortSignal))
    throw new TypeError(typeof config.http_opts.signal + ' received for signal, but expected an AbortSignal');

  // populate http_opts with given TLS options
  tls_options.split(' ').forEach(function(key) {
    if (typeof options[key] != 'undefined') {
      if (config.http_opts.agent) { // pass option to existing agent
        config.http_opts.agent.options[key] = options[key];
      } else {
        config.http_opts[key] = options[key];
      }
    }
  });

  //////////////////////////////////////////////////
  // headers, cookies

  for (var key in defaults.headers)
    config.headers[key] = defaults.headers[key];

  config.headers['accept'] = options.accept || defaults.accept;
  config.headers['user-agent'] = options.user_agent || defaults.user_agent;

  if (options.content_type)
    config.headers['content-type'] = options.content_type;

  // set connection header if opts.connection was passed, or if node < 0.11.4 (close)
  if (options.connection || close_by_default)
    config.headers['connection'] = options.connection || 'close';

  if ((options.compressed || defaults.compressed) && typeof zlib != 'undefined')
    config.headers['accept-encoding'] = decompressors['br'] ? 'gzip, deflate, br' : 'gzip, deflate';

  if (options.cookies)
    config.headers['cookie'] = cookies.write(options.cookies);

  //////////////////////////////////////////////////
  // basic/digest auth

  if (uri.match(/[^\/]@/)) { // url contains user:pass@host, so parse it.
    var parts = (url.parse(uri).auth || '').split(':');
    options.username = parts[0];
    options.password = parts[1];
  }

  if (options.username) {
    if (options.auth && (options.auth == 'auto' || options.auth == 'digest')) {
      config.credentials = [options.username, options.password];
    } else {
      config.headers['authorization'] = auth.basic(options.username, options.password);
    }
  }

  if (config.use_proxy_from_env_var) {
    var env_proxy = utils.get_env_var(['HTTP_PROXY', 'HTTPS_PROXY'], true);
    if (!config.proxy && env_proxy) config.proxy = env_proxy;
  }

  // if proxy is present, set auth header from either url or proxy_user option.
  if (config.proxy) {
    if (!config.use_proxy_from_env_var || utils.should_proxy_to(uri)) {
      if (config.proxy.indexOf('http') === -1)
        config.proxy = 'http://' + config.proxy;

      if (config.proxy.indexOf('@') !== -1) {
        var proxy = (url.parse(config.proxy).auth || '').split(':');
        options.proxy_user = proxy[0];
        options.proxy_pass = proxy[1];
      }

      if (options.proxy_user)
        config.headers['proxy-authorization'] = auth.basic(options.proxy_user, options.proxy_pass);
    } else {
      delete config.proxy;
    }
  }

  // now that all our headers are set, overwrite them if instructed.
  for (var h in options.headers)
    config.headers[h.toLowerCase()] = options.headers[h];

  config.uri_modifier = get_option('uri_modifier', null);

  return config;
}

Needle.prototype.start = function() {

  var out      = new stream.PassThrough({ objectMode: false }),
      uri      = this.uri,
      data     = this.data,
      method   = this.method,
      callback = (typeof this.options == 'function') ? this.options : this.callback,
      options  = this.options || {};

  // if no 'http' is found on URL, prepend it.
  if (uri.indexOf('http') === -1)
    uri = uri.replace(/^(\/\/)?/, 'http://');

  var self = this, body, waiting = false, config = this.setup(uri, options);

  // unless options.json was set to false, assume boss also wants JSON if content-type matches.
  var json = options.json || (options.json !== false && config.headers['content-type'] == 'application/json');

  if (data) {

    if (options.multipart) { // boss says we do multipart. so we do it.
      var boundary = options.boundary || defaults.boundary;

      waiting = true;
      multipart.build(data, boundary, function(err, parts) {
        if (err) throw(err);

        config.headers['content-type'] = 'multipart/form-data; boundary=' + boundary;
        next(parts);
      });

    } else if (utils.is_stream(data)) {

      if (method == 'get')
        throw new Error('Refusing to pipe() a stream via GET. Did you mean .post?');

      if (config.stream_length > 0 || (config.stream_length === 0 && data.path)) {
        // ok, let's get the stream's length and set it as the content-length header.
        // this prevents some servers from cutting us off before all the data is sent.
        waiting = true;
        utils.get_stream_length(data, config.stream_length, function(length) {
          data.length = length;
          next(data);
        })

      } else {
        // if the boss doesn't want us to get the stream's length, or if it doesn't
        // have a file descriptor for that purpose, then just head on.
        body = data;
      }

    } else if (Buffer.isBuffer(data)) {

      body = data; // use the raw buffer as request body.

    } else if (method == 'get' && !json) {

      // append the data to the URI as a querystring.
      uri = uri.replace(/\?.*|$/, '?' + stringify(data));

    } else { // string or object data, no multipart.

      // if string, leave it as it is, otherwise, stringify.
      body = (typeof(data) === 'string') ? data
             : json ? JSON.stringify(data) : stringify(data);

      // ensure we have a buffer so bytecount is correct.
      body = Buffer.from(body, config.encoding);
    }

  }

  function next(body) {
    if (body) {
      if (body.length) config.headers['content-length'] = body.length;

      // if no content-type was passed, determine if json or not.
      if (!config.headers['content-type']) {
        config.headers['content-type'] = json
        ? 'application/json; charset=utf-8'
        : 'application/x-www-form-urlencoded'; // no charset says W3 spec.
      }
    }

    // unless a specific accept header was set, assume json: true wants JSON back.
    if (options.json && (!options.accept && !(options.headers || {}).accept))
      config.headers['accept'] = 'application/json';

    self.send_request(1, method, uri, config, body, out, callback);
  }

  if (!waiting) next(body);
  return out;
}

Needle.prototype.get_request_opts = function(method, uri, config) {
  var opts      = config.http_opts,
      proxy     = config.proxy,
      remote    = proxy ? url.parse(proxy) : url.parse(uri);

  opts.protocol = remote.protocol;
  opts.host     = remote.hostname;
  opts.port     = remote.port || (remote.protocol == 'https:' ? 443 : 80);
  opts.path     = proxy ? uri : remote.pathname + (remote.search || '');
  opts.method   = method;
  opts.headers  = config.headers;

  if (!opts.headers['host']) {
    // if using proxy, make sure the host header shows the final destination
    var target = proxy ? url.parse(uri) : remote;
    opts.headers['host'] = target.hostname;

    // and if a non standard port was passed, append it to the port header
    if (target.port && [80, 443].indexOf(target.port) === -1) {
      opts.headers['host'] += ':' + target.port;
    }
  }

  return opts;
}

Needle.prototype.should_follow = function(location, config, original) {
  if (!location) return false;

  // returns true if location contains matching property (host or protocol)
  function matches(property) {
    var property = original[property];
    return location.indexOf(property) !== -1;
  }

  // first, check whether the requested location is actually different from the original
  if (!config.follow_if_same_location && location === original)
    return false;

  if (config.follow_if_same_host && !matches('host'))
    return false; // host does not match, so not following

  if (config.follow_if_same_protocol && !matches('protocol'))
    return false; // procotol does not match, so not following

  return true;
}

Needle.prototype.send_request = function(count, method, uri, config, post_data, out, callback) {

  if (typeof config.uri_modifier === 'function') {
    var modified_uri = config.uri_modifier(uri);
    debug('Modifying request URI', uri + ' => ' + modified_uri);
    uri = modified_uri;
  }

  var request,
      timer,
      returned     = 0,
      self         = this,
      request_opts = this.get_request_opts(method, uri, config),
      protocol     = request_opts.protocol == 'https:' ? https : http,
      signal       = request_opts.signal;

  function done(err, resp) {
    if (returned++ > 0)
      return debug('Already finished, stopping here.');

    if (timer) clearTimeout(timer);
    request.removeListener('error', had_error);
    out.done = true;

    // An error can still be fired after closing.  In particular, on macOS.
    // See also:
    //  - https://github.com/tomas/needle/issues/391
    //  - https://github.com/less/less.js/issues/3693
    //  - https://github.com/nodejs/node/issues/27916
    request.once('error', function() {});

    if (callback)
      return callback(err, resp, resp ? resp.body : undefined);

    // NOTE: this event used to be called 'end', but the behaviour was confusing
    // when errors ocurred, because the stream would still emit an 'end' event.
    out.emit('done', err);

    // trigger the 'done' event on streams we're being piped to, if any
    var pipes = out._readableState.pipes || [];
    if (!pipes.forEach) pipes = [pipes];
    pipes.forEach(function(st) { st.emit('done', err); })
  }

  function had_error(err) {
    debug('Request error', err);
    out.emit('err', err);
    done(err || new Error('Unknown error when making request.'));
  }

  function abort_handler() {
    out.emit('err', new Error('Aborted by signal.'));
    request.destroy();
  }

  function set_timeout(type, milisecs) {
    if (timer) clearTimeout(timer);
    if (milisecs <= 0) return;

    timer = setTimeout(function() {
      out.emit('timeout', type);
      request.destroy();
      // also invoke done() to terminate job on read_timeout
      if (type == 'read') done(new Error(type + ' timeout'));

      signal && signal.removeEventListener('abort', abort_handler);
    }, milisecs);
  }

  debug('Making request #' + count, request_opts);
  request = protocol.request(request_opts, function(resp) {

    var headers = resp.headers;
    debug('Got response', resp.statusCode, headers);
    out.emit('response', resp);

    set_timeout('read', config.read_timeout);

    // if we got cookies, parse them unless we were instructed not to. make sure to include any
    // cookies that might have been set on previous redirects.
    if (config.parse_cookies && (headers['set-cookie'] || config.previous_resp_cookies)) {
      resp.cookies = extend(config.previous_resp_cookies || {}, cookies.read(headers['set-cookie']));
      debug('Got cookies', resp.cookies);
    }

    // if redirect code is found, determine if we should follow it according to the given options.
    if (redirect_codes.indexOf(resp.statusCode) !== -1 && self.should_follow(headers.location, config, uri)) {
      // clear timer before following redirects to prevent unexpected setTimeout consequence
      clearTimeout(timer);

      if (count <= config.follow_max) {
        out.emit('redirect', headers.location);

        // unless 'follow_keep_method' is true, rewrite the request to GET before continuing.
        if (!config.follow_keep_method) {
          method    = 'GET';
          post_data = null;
          delete config.headers['content-length']; // in case the original was a multipart POST request.
        }

        // if follow_set_cookies is true, insert cookies in the next request's headers.
        // we set both the original request cookies plus any response cookies we might have received.
        if (config.follow_set_cookies && utils.host_and_ports_match(headers.location, uri)) {
          var request_cookies = cookies.read(config.headers['cookie']);
          config.previous_resp_cookies = resp.cookies;
          if (Object.keys(request_cookies).length || Object.keys(resp.cookies || {}).length) {
            config.headers['cookie'] = cookies.write(extend(request_cookies, resp.cookies));
          }
        } else if (config.headers['cookie']) {
          debug('Clearing original request cookie', config.headers['cookie']);
          delete config.headers['cookie'];
        }

        if (config.follow_set_referer)
          config.headers['referer'] = encodeURI(uri); // the original, not the destination URL.

        config.headers['host'] = null; // clear previous Host header to avoid conflicts.

        var redirect_url = utils.resolve_url(headers.location, uri);
        debug('Redirecting to ' +  redirect_url.toString());
        return self.send_request(++count, method, redirect_url.toString(), config, post_data, out, callback);
      } else if (config.follow_max > 0) {
        return done(new Error('Max redirects reached. Possible loop in: ' + headers.location));
      }
    }

    // if auth is requested and credentials were not passed, resend request, provided we have user/pass.
    if (resp.statusCode == 401 && headers['www-authenticate'] && config.credentials) {
      if (!config.headers['authorization']) { // only if authentication hasn't been sent
        var auth_header = auth.header(headers['www-authenticate'], config.credentials, request_opts);

        if (auth_header) {
          config.headers['authorization'] = auth_header;
          return self.send_request(count, method, uri, config, post_data, out, callback);
        }
      }
    }

    // ok, so we got a valid (non-redirect & authorized) response. let's notify the stream guys.
    out.emit('header', resp.statusCode, headers);
    out.emit('headers', headers);

    var pipeline      = [],
        mime          = utils.parse_content_type(headers['content-type']),
        text_response = mime.type && (mime.type.indexOf('text/') != -1 || !!mime.type.match(/(\/|\+)(xml|json)$/));

    // To start, if our body is compressed and we're able to inflate it, do it.
    if (headers['content-encoding'] && decompressors[headers['content-encoding']]) {

      var decompressor = decompressors[headers['content-encoding']]();

      // make sure we catch errors triggered by the decompressor.
      decompressor.on('error', had_error);
      pipeline.push(decompressor);
    }

    // If parse is enabled and we have a parser for it, then go for it.
    if (config.parser && parsers[mime.type]) {

      // If a specific parser was requested, make sure we don't parse other types.
      var parser_name = config.parser.toString().toLowerCase();
      if (['xml', 'json'].indexOf(parser_name) == -1 || parsers[mime.type].name == parser_name) {

        // OK, so either we're parsing all content types or the one requested matches.
        out.parser = parsers[mime.type].name;
        pipeline.push(parsers[mime.type].fn());

        // Set objectMode on out stream to improve performance.
        out._writableState.objectMode = true;
        out._readableState.objectMode = true;
      }

    // If we're not parsing, and unless decoding was disabled, we'll try
    // decoding non UTF-8 bodies to UTF-8, using the iconv-lite library.
    } else if (text_response && config.decode_response && mime.charset) {
      pipeline.push(decoder(mime.charset));
    }

    // And `out` is the stream we finally push the decoded/parsed output to.
    pipeline.push(out);

    // Now, release the kraken!
    utils.pump_streams([resp].concat(pipeline), function(err) {
      if (err) debug(err)

      // on node v8.x, if an error ocurrs on the receiving end,
      // then we want to abort the request to avoid having dangling sockets
      if (err && err.message == 'write after end') request.destroy();
    });

    // If the user has requested and output file, pipe the output stream to it.
    // In stream mode, we will still get the response stream to play with.
    if (config.output && resp.statusCode == 200) {

      // for some reason, simply piping resp to the writable stream doesn't
      // work all the time (stream gets cut in the middle with no warning).
      // so we'll manually need to do the readable/write(chunk) trick.
      var file = fs.createWriteStream(config.output);
      file.on('error', had_error);

      out.on('end', function() {
        if (file.writable) file.end();
      });

      file.on('close', function() {
        delete out.file;
      })

      out.on('readable', function() {
        var chunk;
        while ((chunk = this.read()) !== null) {
          if (file.writable) file.write(chunk);

          // if callback was requested, also push it to resp.body
          if (resp.body) resp.body.push(chunk);
        }
      })

      out.file = file;
    }

    // Only aggregate the full body if a callback was requested.
    if (callback) {
      resp.raw   = [];
      resp.body  = [];
      resp.bytes = 0;

      // Gather and count the amount of (raw) bytes using a PassThrough stream.
      var clean_pipe = new stream.PassThrough();

      clean_pipe.on('readable', function() {
        var chunk;
        while ((chunk = this.read()) != null) {
          resp.bytes += chunk.length;
          resp.raw.push(chunk);
        }
      })

      utils.pump_streams([resp, clean_pipe], function(err) {
        if (err) debug(err);
      });

      // Listen on the 'readable' event to aggregate the chunks, but only if
      // file output wasn't requested. Otherwise we'd have two stream readers.
      if (!config.output || resp.statusCode != 200) {
        out.on('readable', function() {
          var chunk;
          while ((chunk = this.read()) !== null) {
            // We're either pushing buffers or objects, never strings.
            if (typeof chunk == 'string') chunk = Buffer.from(chunk);

            // Push all chunks to resp.body. We'll bind them in resp.end().
            resp.body.push(chunk);
          }
        })
      }
    }

    // And set the .body property once all data is in.
    out.on('end', function() {
      if (resp.body) { // callback mode

        // we want to be able to access to the raw data later, so keep a reference.
        resp.raw = Buffer.concat(resp.raw);

        // if parse was successful, we should have an array with one object
        if (resp.body[0] !== undefined && !Buffer.isBuffer(resp.body[0])) {

          // that's our body right there.
          resp.body = resp.body[0];

          // set the parser property on our response. we may want to check.
          if (out.parser) resp.parser = out.parser;

        } else { // we got one or several buffers. string or binary.
          resp.body = Buffer.concat(resp.body);

          // if we're here and parsed is true, it means we tried to but it didn't work.
          // so given that we got a text response, let's stringify it.
          if (text_response || out.parser) {
            resp.body = resp.body.toString();
          }
        }
      }

      // if an output file is being written to, make sure the callback
      // is triggered after all data has been written to it.
      if (out.file) {
        out.file.on('close', function() {
          done(null, resp);
        })
      } else { // elvis has left the building.
        done(null, resp);
      }

    });

    // out.on('error', function(err) {
    //   had_error(err);
    //   if (err.code == 'ERR_STREAM_DESTROYED' || err.code == 'ERR_STREAM_PREMATURE_CLOSE') {
    //     request.abort();
    //   }
    // })

  }); // end request call

  // unless open_timeout was disabled, set a timeout to abort the request.
  set_timeout('open', config.open_timeout);

  // handle errors on the request object. things might get bumpy.
  request.on('error', had_error);

  // make sure timer is cleared if request is aborted (issue #257)
  request.once('abort', function() {
    if (timer) clearTimeout(timer);
  })

  // set response timeout once we get a valid socket
  request.once('socket', function(socket) {
    if (socket.connecting) {
      socket.once('connect', function() {
        set_timeout('response', config.response_timeout);
      })
    } else {
      set_timeout('response', config.response_timeout);
    }
  })

  if (post_data) {
    if (utils.is_stream(post_data)) {
      utils.pump_streams([post_data, request], function(err) {
        if (err) debug(err);
      });
    } else {
      request.write(post_data, config.encoding);
      request.end();
    }
  } else {
    request.end();
  }

  if (signal) { // abort signal given, so handle it
    if (signal.aborted === true) {
      abort_handler();
    } else {
      signal.addEventListener('abort', abort_handler, { once: true });
    }
  }

  out.abort = function() { request.destroy() }; // easier access
  out.request = request;
  return out;
}

//////////////////////////////////////////
// exports

if (typeof Promise !== 'undefined') {
  module.exports = function() {
    var verb, args = [].slice.call(arguments);

    if (args[0].match(/\.|\//)) // first argument looks like a URL
      verb = (args.length > 2) ? 'post' : 'get';
    else
      verb = args.shift();

    if (verb.match(/get|head/i) && args.length == 2)
      args.splice(1, 0, null); // assume no data if head/get with two args (url, options)

    return new Promise(function(resolve, reject) {
      module.exports.request(verb, args[0], args[1], args[2], function(err, resp) {
        return err ? reject(err) : resolve(resp);
      });
    })
  }
}

module.exports.version = version;

module.exports.defaults = function(obj) {
  for (var key in obj) {
    var target_key = aliased.options[key] || key;

    if (defaults.hasOwnProperty(target_key) && typeof obj[key] != 'undefined') {
      if (target_key != 'parse_response' && target_key != 'proxy' && target_key != 'agent' && target_key != 'signal') {
        // ensure type matches the original, except for proxy/parse_response that can be null/bool or string, and signal that can be null/AbortSignal
        var valid_type = defaults[target_key].constructor.name;

        if (obj[key].constructor.name != valid_type)
          throw new TypeError('Invalid type for ' + key + ', should be ' + valid_type);
      } else if (target_key === 'signal' && obj[key] !== null && !(obj[key] instanceof AbortSignal)) {
        throw new TypeError('Invalid type for ' + key + ', should be AbortSignal');
      }
      defaults[target_key] = obj[key];
    } else {
      throw new Error('Invalid property for defaults:' + target_key);
    }
  }

  return defaults;
}

'head get'.split(' ').forEach(function(method) {
  module.exports[method] = function(uri, options, callback) {
    return new Needle(method, uri, null, options, callback).start();
  }
})

'post put patch delete'.split(' ').forEach(function(method) {
  module.exports[method] = function(uri, data, options, callback) {
    return new Needle(method, uri, data, options, callback).start();
  }
})

module.exports.request = function(method, uri, data, opts, callback) {
  return new Needle(method, uri, data, opts, callback).start();
};

}, function(modId) {var map = {"./querystring":1713256544526,"./multipart":1713256544527,"./auth":1713256544528,"./cookies":1713256544529,"./parsers":1713256544530,"./decoder":1713256544531,"./utils":1713256544532,"../package.json":1713256544533}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544526, function(require, module, exports) {
// based on the qs module, but handles null objects as expected
// fixes by Tomas Pollak.

var toString = Object.prototype.toString;

function stringify(obj, prefix) {
  if (prefix && (obj === null || typeof obj == 'undefined')) {
    return prefix + '=';
  } else if (toString.call(obj) == '[object Array]') {
    return stringifyArray(obj, prefix);
  } else if (toString.call(obj) == '[object Object]') {
    return stringifyObject(obj, prefix);
  } else if (toString.call(obj) == '[object Date]') {
    return obj.toISOString();
  } else if (prefix) { // string inside array or hash
    return prefix + '=' + encodeURIComponent(String(obj));
  } else if (String(obj).indexOf('=') !== -1) { // string with equal sign
    return String(obj);
  } else {
    throw new TypeError('Cannot build a querystring out of: ' + obj);
  }
};

function stringifyArray(arr, prefix) {
  var ret = [];

  for (var i = 0, len = arr.length; i < len; i++) {
    if (prefix)
      ret.push(stringify(arr[i], prefix + '[]'));
    else
      ret.push(stringify(arr[i]));
  }

  return ret.join('&');
}

function stringifyObject(obj, prefix) {
  var ret = [];

  Object.keys(obj).forEach(function(key) {
    ret.push(stringify(obj[key], prefix
      ? prefix + '[' + encodeURIComponent(key) + ']'
      : encodeURIComponent(key)));
  })

  return ret.join('&');
}

exports.build = stringify;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544527, function(require, module, exports) {
var readFile = require('fs').readFile,
    basename = require('path').basename;

exports.build = function(data, boundary, callback) {

  if (typeof data != 'object' || typeof data.pipe == 'function')
    return callback(new Error('Multipart builder expects data as key/val object.'));

  var body   = '',
      object = flatten(data),
      count  = Object.keys(object).length;

  if (count === 0)
    return callback(new Error('Empty multipart body. Invalid data.'))

  function done(err, section) {
    if (err) return callback(err);
    if (section) body += section;
    --count || callback(null, body + '--' + boundary + '--');
  };

  for (var key in object) {
    var value = object[key];
    if (value === null || typeof value == 'undefined') {
      done();
    } else if (Buffer.isBuffer(value)) {
      var part = { buffer: value, content_type: 'application/octet-stream' };
      generate_part(key, part, boundary, done);
    } else {
      var part = (value.buffer || value.file || value.content_type) ? value : { value: value };
      generate_part(key, part, boundary, done);
    }
  }

}

function generate_part(name, part, boundary, callback) {

  var return_part = '--' + boundary + '\r\n';
  return_part += 'Content-Disposition: form-data; name="' + name + '"';

  function append(data, filename) {

    if (data) {
      var binary = part.content_type.indexOf('text') == -1;
      return_part += '; filename="' + encodeURIComponent(filename) + '"\r\n';
      if (binary) return_part += 'Content-Transfer-Encoding: binary\r\n';
      return_part += 'Content-Type: ' + part.content_type + '\r\n\r\n';
      return_part += binary ? data.toString('binary') : data.toString('utf8');
    }

    callback(null, return_part + '\r\n');
  };

  if ((part.file || part.buffer) && part.content_type) {

    var filename = part.filename ? part.filename : part.file ? basename(part.file) : name;
    if (part.buffer) return append(part.buffer, filename);

    readFile(part.file, function(err, data) {
      if (err) return callback(err);
      append(data, filename);
    });

  } else {

    if (typeof part.value == 'object')
      return callback(new Error('Object received for ' + name + ', expected string.'))

    if (part.content_type) {
      return_part += '\r\n';
      return_part += 'Content-Type: ' + part.content_type;
    }

    return_part += '\r\n\r\n';
    return_part += Buffer.from(String(part.value), 'utf8').toString('binary');
    append();

  }

}

// flattens nested objects for multipart body
function flatten(object, into, prefix) {
  into = into || {};

  for(var key in object) {
    var prefix_key = prefix ? prefix + '[' + key + ']' : key;
    var prop = object[key];

    if (prop && typeof prop === 'object' && !(prop.buffer || prop.file || prop.content_type))
      flatten(prop, into, prefix_key)
    else
      into[prefix_key] = prop;
  }

  return into;
}

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544528, function(require, module, exports) {
var createHash = require('crypto').createHash;

function get_header(header, credentials, opts) {
  var type = header.split(' ')[0],
      user = credentials[0],
      pass = credentials[1];

  if (type == 'Digest') {
    return digest.generate(header, user, pass, opts.method, opts.path);
  } else if (type == 'Basic') {
    return basic(user, pass);
  }
}

////////////////////
// basic

function md5(string) {
  return createHash('md5').update(string).digest('hex');
}

function basic(user, pass) {
  var str  = typeof pass == 'undefined' ? user : [user, pass].join(':');
  return 'Basic ' + Buffer.from(str).toString('base64');
}

////////////////////
// digest
// logic inspired from https://github.com/simme/node-http-digest-client

var digest = {};

digest.parse_header = function(header) {
  var challenge = {},
      matches   = header.match(/([a-z0-9_-]+)="?([a-z0-9_=\/\.@\s-\+:)()]+)"?/gi);

  for (var i = 0, l = matches.length; i < l; i++) {
    var parts = matches[i].split('='),
        key   = parts.shift(),
        val   = parts.join('=').replace(/^"/, '').replace(/"$/, '');

    challenge[key] = val;
  }

  return challenge;
}

digest.update_nc = function(nc) {
  var max = 99999999;
  nc++;

  if (nc > max)
    nc = 1;

  var padding = new Array(8).join('0') + '';
  nc = nc + '';
  return padding.substr(0, 8 - nc.length) + nc;
}

digest.generate = function(header, user, pass, method, path) {

  var nc        = 1,
      cnonce    = null,
      challenge = digest.parse_header(header);

  var ha1  = md5(user + ':' + challenge.realm + ':' + pass),
      ha2  = md5(method.toUpperCase() + ':' + path),
      resp = [ha1, challenge.nonce];

  if (typeof challenge.qop === 'string') {
    cnonce = md5(Math.random().toString(36)).substr(0, 8);
    nc     = digest.update_nc(nc);
    resp   = resp.concat(nc, cnonce);
    resp   = resp.concat(challenge.qop, ha2);
  } else {
    resp   = resp.concat(ha2);
  }

  var params = {
    uri      : path,
    realm    : challenge.realm,
    nonce    : challenge.nonce,
    username : user,
    response : md5(resp.join(':'))
  }

  if (challenge.qop) {
    params.qop = challenge.qop;
  }

  if (challenge.opaque) {
    params.opaque = challenge.opaque;
  }

  if (cnonce) {
    params.nc = nc;
    params.cnonce = cnonce;
  }

  header = []
  for (var k in params)
    header.push(k + '="' + params[k] + '"')

  return 'Digest ' + header.join(', ');
}

module.exports = {
  header : get_header,
  basic  : basic,
  digest : digest.generate
}

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544529, function(require, module, exports) {

//  Simple cookie handling implementation based on the standard RFC 6265.
//
//  This module just has two functionalities:
//    - Parse a set-cookie-header as a key value object
//    - Write a cookie-string from a key value object
//
//  All cookie attributes are ignored.

var unescape = require('querystring').unescape;

var COOKIE_PAIR        = /^([^=\s]+)\s*=\s*("?)\s*(.*)\s*\2\s*$/;
var EXCLUDED_CHARS     = /[\x00-\x1F\x7F\x3B\x3B\s\"\,\\"%]/g;
var TRAILING_SEMICOLON = /\x3B+$/;
var SEP_SEMICOLON      = /\s*\x3B\s*/;

// i know these should be 'const', but I'd like to keep
// supporting earlier node.js versions as long as I can. :)

var KEY_INDEX   = 1; // index of key from COOKIE_PAIR match
var VALUE_INDEX = 3; // index of value from COOKIE_PAIR match

// Returns a copy str trimmed and without trainling semicolon.
function cleanCookieString(str) {
  return str.trim().replace(/\x3B+$/, '');
}

function getFirstPair(str) {
  var index = str.indexOf('\x3B');
  return index === -1 ? str : str.substr(0, index);
}

// Returns a encoded copy of str based on RFC6265 S4.1.1.
function encodeCookieComponent(str) {
  return str.toString().replace(EXCLUDED_CHARS, encodeURIComponent);
}

// Parses a set-cookie-string based on the standard defined in RFC6265 S4.1.1.
function parseSetCookieString(str) {
  str = cleanCookieString(str);
  str = getFirstPair(str);

  var res = COOKIE_PAIR.exec(str);
  if (!res || !res[VALUE_INDEX]) return null;

  return {
    name  : unescape(res[KEY_INDEX]),
    value : unescape(res[VALUE_INDEX])
  };
}

// Parses a set-cookie-header and returns a key/value object.
// Each key represents the name of a cookie.
function parseSetCookieHeader(header) {
  if (!header) return {};
  header = Array.isArray(header) ? header : [header];

  return header.reduce(function(res, str) {
    var cookie = parseSetCookieString(str);
    if (cookie) res[cookie.name] = cookie.value;
    return res;
  }, {});
}

// Writes a set-cookie-string based on the standard definded in RFC6265 S4.1.1.
function writeCookieString(obj) {
  return Object.keys(obj).reduce(function(str, name) {
    var encodedName  = encodeCookieComponent(name);
    var encodedValue = encodeCookieComponent(obj[name]);
    str += (str ? '; ' : '') + encodedName + '=' + encodedValue;
    return str;
  }, '');
}

// returns a key/val object from an array of cookie strings
exports.read = parseSetCookieHeader;

// writes a cookie string header
exports.write = writeCookieString;

}, function(modId) { var map = {"querystring":1713256544526}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544530, function(require, module, exports) {
//////////////////////////////////////////
// Defines mappings between content-type
// and the appropriate parsers.
//////////////////////////////////////////

var Transform = require('stream').Transform;
var sax = require('sax');

function parseXML(str, cb) {
  var obj, current, parser = sax.parser(true, { trim: true, lowercase: true })
  parser.onerror = parser.onend = done;

  function done(err) {
    parser.onerror = parser.onend = function() { }
    cb(err, obj)
  }

  function newElement(name, attributes) {
    return {
      name: name || '',
      value: '',
      attributes: attributes || {},
      children: []
    }
  }

  parser.oncdata = parser.ontext = function(t) {
    if (current) current.value += t
  }

  parser.onopentag = function(node) {
    var element = newElement(node.name, node.attributes)
    if (current) {
      element.parent = current
      current.children.push(element)
    } else { // root object
      obj = element
    }

    current = element
  };

  parser.onclosetag = function() {
    if (typeof current.parent !== 'undefined') {
      var just_closed = current
      current = current.parent
      delete just_closed.parent
    }
  }

  parser.write(str).close()
}

function parserFactory(name, fn) {

  function parser() {
    var chunks = [],
        stream = new Transform({ objectMode: true });

    // Buffer all our data
    stream._transform = function(chunk, encoding, done) {
      chunks.push(chunk);
      done();
    }

    // And call the parser when all is there.
    stream._flush = function(done) {
      var self = this,
          data = Buffer.concat(chunks);

      try {
        fn(data, function(err, result) {
          if (err) throw err;
          self.push(result);
        });
      } catch (err) {
        self.push(data); // just pass the original data
      } finally {
        done();
      }
    }

    return stream;
  }

  return { fn: parser, name: name };
}

var parsers = {}

function buildParser(name, types, fn) {
  var parser = parserFactory(name, fn);
  types.forEach(function(type) {
    parsers[type] = parser;
  })
}

buildParser('json', [
  'application/json',
  'application/hal+json',
  'text/javascript',
  'application/vnd.api+json'
], function(buffer, cb) {
  var err, data;
  try { data = JSON.parse(buffer); } catch (e) { err = e; }
  cb(err, data);
});

buildParser('xml', [
  'text/xml',
  'application/xml',
  'application/rdf+xml',
  'application/rss+xml',
  'application/atom+xml'
], function(buffer, cb) {
  parseXML(buffer.toString(), function(err, obj) {
    cb(err, obj)
  })
});

module.exports = parsers;
module.exports.use = buildParser;

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544531, function(require, module, exports) {
var iconv,
    inherits  = require('util').inherits,
    stream    = require('stream');

var regex = /(?:charset|encoding)\s*=\s*['"]? *([\w\-]+)/i;

inherits(StreamDecoder, stream.Transform);

function StreamDecoder(charset) {
  if (!(this instanceof StreamDecoder))
    return new StreamDecoder(charset);

  stream.Transform.call(this, charset);
  this.charset = charset;
  this.parsed_chunk = false;
}

StreamDecoder.prototype._transform = function(chunk, encoding, done) {
  // try to get charset from chunk, but just once
  if (!this.parsed_chunk && (this.charset == 'utf-8' || this.charset == 'utf8')) {
    this.parsed_chunk = true;

    var matches = regex.exec(chunk.toString());

    if (matches) {
      var found = matches[1].toLowerCase().replace('utf8', 'utf-8'); // canonicalize;
      // set charset, but only if iconv can handle it
      if (iconv.encodingExists(found)) this.charset = found;
    }
  }

  // if charset is already utf-8 or given encoding isn't supported, just pass through
  if (this.charset == 'utf-8' || !iconv.encodingExists(this.charset)) {
    this.push(chunk);
    return done();
  }

  // initialize stream decoder if not present
  var self = this;
  if (!this.decoder) {
    this.decoder = iconv.decodeStream(this.charset);
    this.decoder.on('data', function(decoded_chunk) {
      self.push(decoded_chunk);
    });
  };

  this.decoder.write(chunk);
  done();
}

module.exports = function(charset) {
  try {
    if (!iconv) iconv = require('iconv-lite');
  } catch(e) {
    /* iconv not found */
  }

  if (iconv)
    return new StreamDecoder(charset);
  else
    return new stream.PassThrough;
}

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544532, function(require, module, exports) {
var fs = require('fs'),
    url = require('url'),
    stream = require('stream');

function resolve_url(href, base) {
  if (url.URL)
    return new url.URL(href, base);

  // older Node version (< v6.13)
  return base ? url.resolve(base, href) : href;
}

function host_and_ports_match(url1, url2) {
  if (url1.indexOf('http') < 0) url1 = 'http://' + url1;
  if (url2.indexOf('http') < 0) url2 = 'http://' + url2;
  var a = url.parse(url1), b = url.parse(url2);

  return a.host == b.host
    && String(a.port || (a.protocol == 'https:' ? 443 : 80))
    == String(b.port || (b.protocol == 'https:' ? 443 : 80));
}

// returns false if a no_proxy host or pattern matches given url
function should_proxy_to(uri) {
  var no_proxy = get_env_var(['NO_PROXY'], true);
  if (!no_proxy) return true;

  // previous (naive, simple) strategy
  // var host, hosts = no_proxy.split(',');
  // for (var i in hosts) {
  //   host = hosts[i];
  //   if (host_and_ports_match(host, uri)) {
  //     return false;
  //   }
  // }

  var pattern, pattern_list = no_proxy.split(/[\s,]+/);
  for (var i in pattern_list) {
    pattern = pattern_list[i];
    if (pattern.trim().length == 0) continue;

    // replace leading dot by asterisk, escape dots and finally replace asterisk by .*
    var regex = new RegExp(pattern.replace(/^\./, "*").replace(/[.]/g, '\\$&').replace(/\*/g, '.*'))
    if (uri.match(regex)) return false;
  }

  return true;
}

function get_env_var(keys, try_lower) {
  var val, i = -1, env = process.env;
  while (!val && i < keys.length-1) {
    val = env[keys[++i]];
    if (!val && try_lower) {
      val = env[keys[i].toLowerCase()];
    }
  }
  return val;
}

function parse_content_type(header) {
  if (!header || header === '') return {};

  var found, charset = 'utf8', arr = header.split(';');

  if (arr.length > 1 && (found = arr[1].match(/charset=(.+)/)))
    charset = found[1];

  return { type: arr[0], charset: charset };
}

function is_stream(obj) {
  return typeof obj.pipe === 'function';
}

function get_stream_length(stream, given_length, cb) {
  if (given_length > 0)
    return cb(given_length);

  if (stream.end !== void 0 && stream.end !== Infinity && stream.start !== void 0)
    return cb((stream.end + 1) - (stream.start || 0));

  fs.stat(stream.path, function(err, stat) {
    cb(stat ? stat.size - (stream.start || 0) : null);
  });
}

function pump_streams(streams, cb) {
  if (stream.pipeline)
    return stream.pipeline.apply(null, streams.concat(cb));

  var tmp = streams.shift();
  while (streams.length) {
    tmp = tmp.pipe(streams.shift());
    tmp.once('error', function(e) {
      cb && cb(e);
      cb = null;
    })
  }
}

module.exports = {
  resolve_url: resolve_url,
  get_env_var: get_env_var,
  host_and_ports_match: host_and_ports_match,
  should_proxy_to: should_proxy_to,
  parse_content_type: parse_content_type,
  is_stream: is_stream,
  get_stream_length: get_stream_length,
  pump_streams: pump_streams
}
}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
__DEFINE__(1713256544533, function(require, module, exports) {
module.exports = {
  "name": "needle",
  "version": "3.3.1",
  "description": "The leanest and most handsome HTTP client in the Nodelands.",
  "keywords": [
    "http",
    "https",
    "simple",
    "request",
    "client",
    "multipart",
    "upload",
    "proxy",
    "deflate",
    "timeout",
    "charset",
    "iconv",
    "cookie",
    "redirect"
  ],
  "tags": [
    "http",
    "https",
    "simple",
    "request",
    "client",
    "multipart",
    "upload",
    "proxy",
    "deflate",
    "timeout",
    "charset",
    "iconv",
    "cookie",
    "redirect"
  ],
  "author": "Tomás Pollak <tomas@forkhq.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/tomas/needle.git"
  },
  "dependencies": {
    "iconv-lite": "^0.6.3",
    "sax": "^1.2.4"
  },
  "devDependencies": {
    "JSONStream": "^1.3.5",
    "jschardet": "^1.6.0",
    "mocha": "^5.2.0",
    "pump": "^3.0.0",
    "q": "^1.5.1",
    "should": "^13.2.3",
    "sinon": "^2.3.0",
    "xml2js": "^0.4.19"
  },
  "scripts": {
    "test": "mocha test"
  },
  "directories": {
    "lib": "./lib"
  },
  "main": "./lib/needle",
  "bin": {
    "needle": "./bin/needle"
  },
  "license": "MIT",
  "engines": {
    "node": ">= 4.4.x"
  }
}

}, function(modId) { var map = {}; return __REQUIRE__(map[modId], modId); })
return __REQUIRE__(1713256544525);
})()
//miniprogram-npm-outsideDeps=["fs","http","https","url","stream","util","zlib","path","crypto","sax","iconv-lite"]
//# sourceMappingURL=index.js.map