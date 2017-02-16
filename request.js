/**
 *
 * Copyright (c) 2017 InterDigital, Inc. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var request = require('request'),
  qs = require('querystring'),
  url = require('url'),
  path = require('path');

function Request() {}

Request.prototype = {};

Request.prototype.hostCheck = function(host, channel, next) {
  var config = this.pod.getConfig();
  this.$resource._isVisibleHost.call(this.pod, host, function(err, blacklisted) {
    next(err, blacklisted ? blacklisted.length !== 0 : false);
  }, channel, config.whitelist);
}

Request.prototype.rpc = function(method, sysImports, options, channel, req, res) {
  var url;

  if (req.query.url) {
    url = req.query.url;
  } else if (channel && channel.config && channel.config.url) {
    url = channel.config.url;
  }

  if (url) {
    this.hostCheck(url, channel, function(err, blacklisted) {
      if (err) {
        res.send(500);
      } else if (blacklisted) {
        res.send({ message : 'Requested host [' + url + '] is blacklisted' }, 403);
      } else if (!url) {
        res.send(404);
      } else {
        try {
          if (method === 'proxy') {
            var headers = app._.clone(req.headers);

            // if url has basic auth injected into url, then drop it
            // from proxy
            if (/\/\/.*:.*@/.test(url) ) {
              delete headers.authorization;
            }
            delete headers.host;

            var isJSON = false;
            try {
              JSON.stringify(req.body);
              isJSON = true;
            } catch (e) {};

            var options = {
              uri : url,
              method : req.method,
              headers : headers,
              json : isJSON,
              body : req.body
            }

            request(options).pipe(res);
          } else if (method === 'redirect' && url) {
            res.redirect(url);

          } else {
            res.send(404);
          }
        } catch (e) {
          res.send(e.message, 500)
        }
      }
    });
  } else {
    res.send(404);
  }
}

function fib(n) {
  return function(n, a, b) {
    return n > 0 ? arguments.callee(n - 1, b, a + b) : a;
  }(n, 0, 1);
}

function parseHeaders(headerStr) {
  var lines = headerStr.split(/\r?\n/),
    headers = {},
    tokens,
    k;

  for (var i = 0; i < lines.length; i++) {
    if (lines[i]) {
      tokens = lines[i].split(':');
      k = tokens.shift();
      headers[k] = tokens.join(':').trim();
    }
  }

  return headers;
}

Request.prototype.invoke = function(imports, channel, sysImports, contentParts, next) {
  var $resource = this.$resource,
    struct = {},
    headers = {},
    self = this,
    url = imports.url,
    invokeArgs = arguments,
    retryResponse = imports.forward_retry_responses,
    f;

  struct.method = imports.method;
  struct.url = url;

  // normalize retries
  if (imports.retries) {
    imports.retries = Number(imports.retries);
    if (isNaN(imports.retries)) {
      imports.retries = 0;
    } else if (imports.retries > 20) {
      imports.retries = 20;
    }
  }

  if (imports.headers) {
    headers = parseHeaders(imports.headers);
  }

  this.hostCheck(url, channel, function(err, blacklisted) {
    if (err) {
      next(err, {});
    } else if (blacklisted) {
      next('Requested host [' + url + '] is blacklisted', {});
    } else {
      // handle posts
      if (/^post$/i.test(struct.method)) {
        if (imports.post_files && $resource.helper.isTruthy(imports.post_files) && contentParts && contentParts._files) {
          struct.multipart = contentParts._files;
        } else {
          struct.multipart = [];
        }

        if (struct.multipart.length) {
          for (var f = 0; f < struct.multipart.length; f++) {
            var req = request.post(
              struct.url,
              {
                headers : headers
              },
              function(err, res, body) {
                if (err) {
                  next(err);
                } else {
                  if (!imports.retries && res.statusCode !== 200) {
                    next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
                  } else if (imports.retries) {
                    (function(self, channel, invokeArgs) {
                      if (!imports._retry) {
                        imports._retry = 1;
                      }
                      var secondsTimeout = fib(imports._retry);
                      $resource.log('Retrying in ' + secondsTimeout + ' seconds', channel);

                      setTimeout(function() {
                        imports.retries--;
                        imports._retry++;
                        self.invoke.apply(self, invokeArgs);
                      }, secondsTimeout * 1000);

                    })(self, channel, invokeArgs);
                  }

                  if (retryResponse) {
                    next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode });
                  }
                }
              }),
              form = req.form();

            $resource.file.get(struct.multipart[f], function(err, fileStruct, readStream) {
              if (err) {
                next(err);
              } else {
                form.append('file',
                  readStream,
                  {
                    filename : fileStruct.name,
                    contentType : fileStruct.type
                  }
                );
              }
            });
          }
        } else {
          // convert query string to post vars
          var formData = {};
          if (imports.body) {
            if ($resource.helper.isObject(imports.body)) {
              formData = imports.body;
            } else {
              formData = qs.parse(imports.body);
            }
          } else {
            formData = imports;
          }

          var req = request.post(struct.url, { form : formData, headers : headers }, function(err, res, body) {
            if (err) {
              next(err);
            } else {
              if (!(res.statusCode === 200 || res.statusCode === 201)) {
                next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
              } else {
                next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode} )
              }
            }
          });
        }

      } else {
        var opts = {
          uri:     struct.url,
          method:  struct.method,
          headers: headers
        };

        if (/^put$/i.test(opts.method) && imports.body) {
          opts.body = imports.body
        }

        if (imports.query_string) {
          if ($resource.helper.isObject(imports.query_string)) {
            opts.qs = imports.query_string;
          } else {
            opts.qs = qs.parse(imports.query_string);
          }
        }

        var req = request(opts, function(err, res, body) {
          var ext;
          if (err) {
            next(err);
          } else {
            if (!imports.retries && res.statusCode !== 200) {
              next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
            } else {
              if (imports.retries && res.statusCode !== 200) {
                (function(self, channel, invokeArgs) {
                  if (!imports._retry) {
                    imports._retry = 1;
                  }
                  var secondsTimeout = fib(imports._retry);
                  $resource.log('Retrying in ' + secondsTimeout + ' seconds', channel);

                  setTimeout(function() {
                    imports.retries--;
                    imports._retry++;
                    self.invoke.apply(self, invokeArgs);
                  }, secondsTimeout * 1000);
                })(self, channel, invokeArgs);

                if ((!ext || 'json' === ext || 'html' === ext) && retryResponse) {
                  next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode}, body.length);
                }
              } else {
                if (/^put$/i.test(opts.method)) {
                  res.headers['content-type'] = "application/json";
                }

                ext = $resource.mime.extension(res.headers['content-type']);

                var exports = {
                  response : body,
                  contentType : res.headers['content-type'],
                  status : res.statusCode
                };

                // json/html and anything we can't turn into a file gets pushed into the
                // body export.
                if (!ext || 'json' === ext || 'html' === ext || 'xml' === ext) {
                  next(false, exports, body.length);
                } else {
                  // request is basically useless if you don't know what kind of
                  // file you're retrieving, so if it looks like a file, request
                  // it again via the pod streaming helper :
                  dataDir = self.pod.getDataDir(channel, 'request');

                  var localPath = dataDir + struct.url.split('/').pop();

                  delete exports.response;

                  $resource._httpStreamToFile(
                    struct.url,
                    localPath,
                    function(err, fileStruct) {
                      if (err) {
                        next(err);
                      } else {
                        contentParts._files.push(fileStruct);
                        next(false, exports, contentParts, fileStruct.size);
                      }
                    },
                    false,
                    headers
                  );

                }
              }
            }
          }
        });
      }
    }
  });

}

// -----------------------------------------------------------------------------
module.exports = Request;

