var assert = require('assert')
  , path = require('path')
  , http = require('http')
  , rimraf = require('rimraf')
  , express = require('express')
  , nunjucks = require('nunjucks')
  , fs = require('fs')
  , port = 12435;

var Manager = require('../').Manager
  , fixtures = path.join(__dirname, 'fixtures')
  , temp = path.join(__dirname, 'tmp');

function mocks(callback) {
    var app = express()
      , port_ = port++;
    app.use(function (request, response, next) {
        response.render = function (template) {
            var locals = {};
            for (var key in response.locals) {
                locals[key] = response.locals[key];
            }
            response.send(nunjucks.renderString(template, locals));
        };
        next();
    });
    var server = app.listen(port_);
    function request(uri, callback) {
        http.request({
            hostname: 'localhost'
          , port: port_
          , method: 'GET'
          , path: uri
        }, function (response) {
            var body = '';
            response.setEncoding('utf8');
            response.on('data', function (chunk) {
                body += chunk;
            }).on('end', function () {
                callback(null, response, body);
            });
        }).end();
    }
    callback(app, request, function (done) {
        server.close();
        done();
    });
}

describe('Middleware', function () {

    it('should provide express middleware', function (done) {
        var manager = new Manager(path.join(fixtures, 'empty'));
        mocks(function (app, request, next) {
            manager.init(app);
            app.get('/foo.txt', function (request, response) {
                response.send('foo');
            });
            request('/foo.txt', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(body, 'foo');
                next(done);
            });
        });
    });

    it('should provide a view helper for defining assets', function (done) {
        var manager = new Manager(path.join(fixtures, 'empty'));
        manager.asset = function () {
            return 'foo';
        };
        mocks(function (app, request, next) {
            manager.init(app);
            app.get('/', function (request, response) {
                response.render('{{ asset("foo.css") }}');
            });
            request('/', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(body, 'foo');
                next(done);
            });
        });
    });

    it('should let users modify the view helper name', function (done) {
        var manager = new Manager(path.join(fixtures, 'empty'), {
            viewHelper: 'foobarbaz'
        });
        manager.asset = function () {
            return 'foo';
        };
        mocks(function (app, request, next) {
            manager.init(app);
            app.get('/', function (request, response) {
                response.render('{{ foobarbaz("foo.css") }}');
            });
            request('/', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(body, 'foo');
                next(done);
            });
        });
    });

    it('should serve static assets', function (done) {
        var manager = new Manager(path.join(fixtures, 'simple-assets'));
        mocks(function (app, request, next) {
            manager.init(app);
            request('/jquery.js', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(response.headers['content-type'], 'application/javascript');
                assert.equal(response.headers['cache-control'], 'public, max-age=0');
                assert.equal(body.trim(), 'window.jQuery = {};');
                next(done);
            });
        });
    });

    it('should serve static assets with a configurable max-age', function (done) {
        var manager = new Manager(path.join(fixtures, 'simple-assets'), {
            maxAge: 86400000
        });
        mocks(function (app, request, next) {
            manager.init(app);
            request('/jquery.js', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(response.headers['content-type'], 'application/javascript');
                assert.equal(response.headers['cache-control'], 'public, max-age=86400');
                assert.equal(body.trim(), 'window.jQuery = {};');
                next(done);
            });
        });
    });

    it('should serve static assets from a configurable prefix', function (done) {
        var manager = new Manager(path.join(fixtures, 'simple-assets'), {
            servePrefix: '/static'
        });
        mocks(function (app, request, next) {
            manager.init(app);
            request('/static/jquery.js', function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(response.headers['content-type'], 'application/javascript');
                assert.equal(body.trim(), 'window.jQuery = {};');
                next(done);
            });
        });
    });

    it('should 404 when a compiled asset that\'s unknown to the manager is encountered', function (done) {
        var manager = new Manager(path.join(fixtures, 'simple-assets'), {
            servePrefix: '/static'
        });
        mocks(function (app, request, next) {
            manager.init(app);
            request('/static/asset-123456-jquery.js', function (err, response) {
                assert.ifError(err);
                assert.equal(response.statusCode, 404);
                next(done);
            });
        });
    });

    it('should compile and serve a single file asset', function (done) {
        var assets = path.join(fixtures, 'simple-assets');
        var manager = new Manager(assets);
        mocks(function (app, request, next) {
            manager.init(app);
            var jquery = manager.assetPath('jquery.js');
            rimraf.sync(path.join(assets, jquery));
            request(jquery, function (err, response, body) {
                assert.ifError(err);
                assert.equal(response.statusCode, 200);
                assert.equal(response.headers['content-type'], 'application/javascript');
                assert.equal(body.trim(), 'window.jQuery = {};');
                next(done);
            });
        });
    });

    it('should 500 when an asset read error occurs', function (done) {
        rimraf.sync(temp);
        fs.mkdirSync(temp);
        var jqueryPath = path.join(temp, 'jquery.js');
        fs.writeFileSync(jqueryPath, 'var foo');
        var manager = new Manager(temp);
        mocks(function (app, request, next) {
            manager.init(app);
            var requestError;
            app.use(function (err, request, response, next) {
                requestError = err;
                next = next; //-jshint
                response.send(500);
            });
            //Let's be pathological and replace jquery.js with a directory
            fs.unlinkSync(jqueryPath);
            fs.mkdirSync(jqueryPath);
            var jquery = manager.assetPath('jquery.js');
            request(jquery, function (err, response) {
                assert.ifError(err);
                assert(requestError && requestError.message.indexOf('EISDIR') >= 0,
                    'Expected an EISDIR error');
                assert.equal(response.statusCode, 500);
                next(done);
            });
        });
    });

});
