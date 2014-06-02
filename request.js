/**
 *
 * @author Michael Pearson <michael@cloudspark.com.au>
 * Copyright (c) 2010-2014 CloudSpark pty ltd http://www.cloudspark.com.au
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var request = require('request'),
fs = require('fs'),
qs = require('querystring'),
url = require('url'),
path = require('path');

function Request(podConfig) {
  this.name = 'request';
  this.description = 'HTTP Request',
  this.description_long = 'Makes a HTTP Request, exporting the response body or generating a file',
  this.trigger = false;
  this.singleton = false;
  this.auto = false;
  this.podConfig = podConfig;
}

Request.prototype = {};

Request.prototype.getSchema = function() {
  return {
    "imports": {
      "properties" : {
        "method" : {
          "type" : "string",
          "description" : "Request Method",
          "default" : "GET",
          oneOf : [
          {
            "$ref" : "#/config/definitions/method"
          }
          ]
        },
        "url" : {
          "type" : "string",
          "description" : "URL"
        },
        "query_string" : {
          "type" : "string",
          "description" : "Query String"
        },
        "body" : {
          "type" : "string",
          "description" : "POST/PUT Body"
        }
      }
    },
    "exports": {
      "properties" : {
        "response" : {
          "type" : "string",
          "description" : "Response Body"
        },
        "content-type" : {
          "type" : "string",
          "description" : "Response Content Type"
        },
        "status" : {
          "type" : "integer",
          "description" : "HTTP Response Status"
        }
      }
    },
    "config": {
      "properties" : {
        "method" : {
          "type" : "string",
          "description" : "Default Request Method",
          "default" : "GET",
          oneOf : [
          {
            "$ref" : "#/config/definitions/method"
          }
          ]
        },
        "url" : {
          "type" : "string",
          "description" : "Default URL"
        },
        "post_files" : {
          "type" : "boolean",
          "description" : "POST any present file",
          "default" : false
        },
        "retries" : {
          "type" : "integer",
          "description" : "# Retries",
          "default" : 0,
          "maximum" : 20
        },
        "forward_retry_responses" : {
          "type" : "boolean",
          "description" : "Forward Retry Responses",
          "default" : false
        }
      },
      "definitions" : {        
        "method" : {
          "description" : "HTTP Request Method",
          "enum" : [ "GET" , "POST", "PUT", "DELETE", "HEAD", "PATCH" ],
          "enum_label" : [ "GET" , "POST", "PUT", "DELETE", "HEAD", "PATCH" ],
          "default" : "GET"
        }
      }
    },
    "renderers" : {
      "proxy" : {
        description : "HTTP Proxy",
        contentType : "Mixed Content"
      },
      "redirect" : {
        description : "HTTP Redirect",
        description : "Redirects to configured URL",
        contentType : "Mixed Content"
      }
    }
  }
}

Request.prototype.hostCheck = function(host, channel, next) {
  this.$resource._isVisibleHost(host, function(err, blacklisted) {
    next(err, blacklisted.length !== 0);
  }, channel, this.podConfig.whitelist);
}

Request.prototype.rpc = function(method, sysImports, options, channel, req, res) {
  var url = channel.config.url;

  if (req.query.url) {
    url = req.query.url;
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
            request(url).pipe(res);

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

Request.prototype.invoke = function(imports, channel, sysImports, contentParts, next) {
  var $resource = this.$resource,
    uri = imports.url && '' !== imports.url ? imports.url : channel.config.url,
    method = imports.method && '' !== imports.method ? imports.method : channel.config.method,
    struct = {},
    self = this,
    invokeArgs = arguments,
    retryResponse = channel.config.forward_retry_responses,
    f;

  if (uri && method) {
    struct.method = method;
    struct.uri = uri;

    // normalize retries
    if (channel.config.retries) {
      channel.config.retries = Number(channel.config.retries);
      if (isNaN(channel.config.retries)) {
        channel.config.retries = 0;
      } else if (channel.config.retries > 20) {
        channel.config.retries = 20;
      }
    }

    this.hostCheck(uri, channel, function(err, blacklisted) {
      if (err) {
        next(err, {});
      } else if (blacklisted) {
        next('Requested host [' + uri + '] is blacklisted', {});
      } else {

        // handle posts
        if (/^post$/i.test(struct.method)) {
          if (channel.config.post_files && app.helper.isTrue(channel.config.post_files) && contentParts && contentParts._files) {
            struct.multipart = contentParts._files;
          } else {
            struct.multipart = [];
          }

          if (struct.multipart.length) {
            for (var f = 0; f < struct.multipart.length; f++) {
              var req = request.post(struct.uri, function(err, res, body) {
                if (err) {
                  next(err);
                } else {
                  if (!channel.config.retries && res.statusCode !== 200) {
                    next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
                  } else if (channel.config.retries) {                      
                    (function(self, channel, invokeArgs) {
                      if (!channel.config._retry) {
                        channel.config._retry = 1;
                      }
                      var secondsTimeout = fib(channel.config._retry);
                      $resource.log('Retrying in ' + secondsTimeout + ' seconds', channel);

                      setTimeout(function() {
                        channel.config.retries--;
                        channel.config._retry++;
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

              form.append(
                'file',
                fs.createReadStream(path.join(struct.multipart[f].localpath)),
                {
                  filename : struct.multipart[f].localpath.name,
                  contentType : struct.multipart[f].localpath.type
                }
              );
            }
          } else {
            // convert query string to post vars
            var formData = {};
            if (imports.body) {
              if (app.helper.isObject(imports.body)) {
                formData = imports.body;
              } else {
                formData = qs.parse(imports.body);
              }
            } else {
              formData = imports;
            }

            var req = request.post(struct.uri, { form : formData }, function(err, res, body) {
              if (err) {
                next(err);
              } else {
                if (res.statusCode !== 200) {
                  next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
                } else {
                  next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode} )
                }
              }
            });
          }

        } else {
          var opts = {
            uri : struct.uri,
            method : struct.method
          };

          if (imports.query_string) {
            if (app.helper.isObject(imports.query_string)) {
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
              if (!channel.config.retries && res.statusCode !== 200) {
                next('Request Fail ' + (res.headers.status || res.headers['www-authenticate']));
              } else {

                if (channel.config.retries && res.statusCode !== 200) {                      
                  (function(self, channel, invokeArgs) {
                    if (!channel.config._retry) {
                      channel.config._retry = 1;
                    }
                    var secondsTimeout = fib(channel.config._retry);
                    $resource.log('Retrying in ' + secondsTimeout + ' seconds', channel);
                    
                    setTimeout(function() {
                      channel.config.retries--;
                      channel.config._retry++;
                      self.invoke.apply(self, invokeArgs);
                    }, secondsTimeout * 1000);                    
                  })(self, channel, invokeArgs);                      
                  
                  if ((!ext || 'json' === ext || 'html' === ext) && retryResponse) {
                    next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode}, body.length);
                  }
                } else {

                  ext = $resource.mime.extension(res.headers['content-type']);

                  // json/html and anything we can't turn into a file gets pushed into the
                  // body export.
                  if (!ext || 'json' === ext || 'html' === ext) {
                    next(false, { response : body, contentType : res.headers['content-type'], status : res.statusCode}, body.length);
                  } else {                 
                    // request is basically useless if you don't know what kind of
                    // file you're retrieving, so if it looks like a file, request
                    // it again via the pod streaming helper :
                    self.pod.getDataDir(channel, 'request', function(err, dataDir) {
                      var urlFileName = struct.uri.split('/').pop(),
                        fName = $resource.uuid.v4() + '.' + ext,
                        localPath = dataDir + fName,
                        fileStruct = {
                          txId : sysImports.client.id,
                          size : body.length,
                          localpath : localPath,
                          name : urlFileName || fName,
                          type : res.headers['content-type'],
                          encoding : 'binary' // @todo how to get buffer encoding?
                        };

                      // if there's no file extension on retrieved file then set it
                      var extRegExp = new RegExp('\.' + ext + '$');
                      if (!extRegExp.test(fileStruct.name)) {
                        fileStruct.name += '.' + ext;
                      }                      

                      self.pod._httpStreamToFile(struct.uri, localPath, function(err, exports, fileStruct) {
                        if (err) {
                          next(err);
                        } else {
                          contentParts._files.push(fileStruct);
                          next(
                            false,
                            exports,
                            contentParts,
                            fileStruct.size
                          );
                        }
                      }, {}, fileStruct);
                    });
                  }
                }
              }
            }
          });
        }
      }
    });
  }
}

// -----------------------------------------------------------------------------
module.exports = Request;

