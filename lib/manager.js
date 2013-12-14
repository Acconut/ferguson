var EventEmitter = require('events').EventEmitter
  , inherits = require('util').inherits
  , format = require('util').format
  , minimatch = require('minimatch')
  , express = require('express')
  , assert = require('assert')
  , async = require('async')
  , path = require('path')
  , fs = require('fs')
  , utils = require('./utils')
  , tags = require('./tags')
  , compressors = require('./compressors');

/**
 * Default asset manager options.
 */

var defaultOptions = {
    assetPrefix: 'asset'
  , hash: 'md5'
  , hashLength: 32
  , viewHelper: 'asset'
  , manifest: '.asset-manifest'
  , servePrefix: '/'
  , urlPrefix: ''
  , tags: tags
  , compilers: {}
  , compressors: compressors
  , maxAge: 4 * 7 * 24 * 60 * 60 * 1000
  , compress: false
  , hotReload: false
  , wrapJavascript: false
  , javascriptIIFE: '!function(){%s}();'
  , separateBundles: false
  , html5: false
};

/**
 * Create a new Manager instance.
 *
 * @param {String} dir - the directory where static assets live
 * @param {Object} options (optional)
 */

function Manager(dir, options) {
    this.dir = dir;
    this.options = utils.mergeDefaults(options, defaultOptions);
    this.compiledPattern = new RegExp(format('^%s-%s-',
        utils.escapeRegex(this.options.assetPrefix)
      , '[0-9a-f]+?'
    ));
    this.assets = {};
    this.compiledAssets = {};
    this.pendingAssets = {};
    this.compilingNow = {};

    this.reverseCompilerIndex = {};
    var extname, compiler;
    for (extname in this.options.compilers) {
        compiler = this.options.compilers[extname];
        compiler.extname = extname;
        if (!(compiler.output in this.reverseCompilerIndex)) {
            this.reverseCompilerIndex[compiler.output] = [];
        }
        this.reverseCompilerIndex[compiler.output].push(compiler);
    }
}

inherits(Manager, EventEmitter);

exports.Manager = Manager;

/**
 * Initialse the asset manager and bind it to an express app.
 *
 * @param {Express} app
 * @return {Manager} this
 */

Manager.prototype.init = function (app) {
    if (!this.initialised) {
        this.indexAssets();
        this.hashAssets();
        if (this.options.hotReload) {
            this.watchDirectory();
        }
        this.initialised = true;
    }

    //Serve existing assets using the express static middleware
    var staticAssets = express.static(this.dir, {
        maxAge: this.options.maxAge
    });
    app.use(this.options.servePrefix, staticAssets);

    //Bind view helpers
    var helperName = this.options.viewHelper
      , helper = app.asset = this.asset.bind(this);
    helper.path = this.assetPath.bind(this);
    helper.url = this.assetUrl.bind(this);
    app.use(function (request, response, next) {
        response.locals[helperName] = response.asset = helper;
        next();
    });

    //Compile assets. Concurrent requests to the same asset are queued while
    //the first request does the actual compilation
    var self = this;
    app.use(this.options.servePrefix, function (request, response, next) {
        if (!self.isCompiledAsset(request.url)) {
            return next();
        }
        var canonical = self.getCanonicalPath(request.url).slice(1)
          , asset = self.pendingAssets[canonical];
        if (!asset) {
            return next();
        }
        if (!(canonical in self.compilingNow)) {
            self.compilingNow[canonical] = [];
            request._canonicalAssetName = canonical;
            self.compileAsset(asset, next);
        } else {
            self.compilingNow[canonical].push(next);
        }
    });

    //Resume each request that was waiting on compilation to finish
    function resume(next) {
        next();
    }
    app.use(this.options.servePrefix, function (request, response, next) {
        if (!request._canonicalAssetName) {
            return next();
        }
        var canonical = request._canonicalAssetName
          , pendingRequests = self.compilingNow[canonical];
        delete self.compilingNow[canonical];
        pendingRequests.forEach(resume);
        next();
    });

    //Handle compilation failures
    app.use(this.options.servePrefix, function (err, request, response, next) {
        if (!request._canonicalAssetName) {
            return next(err);
        }
        var canonical = request._canonicalAssetName
          , pendingRequests = self.compilingNow[canonical];
        delete self.compilingNow[canonical];
        pendingRequests.forEach(function (resume) {
            resume(err);
        });
        next(err);
    });

    app.use(this.options.servePrefix, staticAssets);

    return this;
};

/**
 * Compile an asset and write it to the static directory.
 *
 * @param {Object} file
 * @param {Function} callback
 */

Manager.prototype.compileAsset = function (file, callback) {
    var contents = [], self = this;
    async.eachSeries(file.assets, function (asset, next) {
        var assetPath = path.join(self.dir, asset.name)
          , extname = path.extname(asset.name);
        fs.readFile(assetPath, { encoding: 'utf8' }, function (err, fileContents) {
            if (err) {
                var message = format('Failed to read file "%s": %s',
                    asset.name, err.message);
                return next(new Error(message));
            }
            var compiler = self.options.compilers[extname];
            if (!compiler) {
                contents.push(fileContents);
                return next();
            }
            compiler.compile(fileContents, self.options, function (err, compiled) {
                if (err) {
                    var message = format('Failed to compile file "%s": %s',
                        asset.name, err.message);
                    return next(new Error(message));
                }
                contents.push(compiled);
                next();
            });
        });
    }, function (err) {
        if (err) return callback(err);
        contents = contents.join('');
        var outputPath = path.join(self.dir, file.path)
          , extname = path.extname(outputPath);
        if (extname === '.js' && self.options.wrapJavascript) {
            contents = format(self.options.javascriptIIFE, contents);
        }
        if (!self.options.compress || !(extname in self.options.compressors)) {
            return fs.writeFile(outputPath, contents, callback);
        }
        self.options.compressors[extname](contents, self.options, function (err, compressed) {
            if (err) {
                var message = format('Failed to compress asset "%s": %s',
                    file.path, err.message);
                return callback(new Error(message));
            }
            return fs.writeFile(outputPath, compressed, callback);
        });
    });
};

/**
 * Index the directory of static assets.
 */

Manager.prototype.indexAssets = function () {
    var self = this;
    this.getAssets().forEach(function (file) {
        if (self.isCompiledAsset(file.name)) {
            var canonical = self.getCanonicalPath(file.name);
            if (!(canonical in self.compiledAssets)) {
                self.compiledAssets[canonical] = [];
            }
            self.compiledAssets[canonical].push(file.name);
        } else if (file.name !== self.options.manifest) {
            self.assets[file.name.toLowerCase()] = file;
        }
    });
};

/**
 * Get a list of all static assets and their mtimes.
 *
 * @return {Array} files
 */

Manager.prototype.getAssets = function () {
    var assets;
    try {
        assets = utils.walkDirectory(this.dir);
    } catch (err) {
        var message = 'Failed to locate assets: ' + err.toString();
        this.emit('error', new Error(message));
    }
    return assets;
};

/**
 * Calculate asset hashes based on file contents.
 *
 * @return {Boolean} outdated - true if at least one file had to be hashed
 */

Manager.prototype.hashAssets = function () {
    var manifestPath = path.join(this.dir, this.options.manifest)
      , manifest, outdated = false;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath).toString());
        assert.equal(typeof manifest, 'object');
    } catch (err) {
        manifest = {};
    }
    var file, filename;
    for (filename in this.assets) {
        file = this.assets[filename];
        if (filename in manifest && manifest[filename].mtime === file.mtime) {
            file.hash = manifest[filename].hash;
        } else {
            file.hash = utils.hashFile(path.join(this.dir, filename), this.options.hash);
            outdated = true;
        }
    }
    if (outdated) {
        this.writeManifest();
    }
    return outdated;
};

/**
 * Cache the in-memory index to a manifest file.
 */

Manager.prototype.writeManifest = function () {
    var manifestPath = path.join(this.dir, this.options.manifest);
    try {
        fs.writeFileSync(manifestPath, JSON.stringify(this.assets));
    } catch (err) {
        var message = 'Failed to write the assets manifest: ' + err.toString();
        this.emit('error', new Error(message));
    }
};

/**
 * Define assets and return the resulting tags.
 *
 * This function also serves as the view helper available to templates.
 *
 * @param {String} identifier
 * @param {Object} options (optional)
 * @param {Boolean} force (optional) - ignore any existing asset definitions
 * @return {String} html
 */

Manager.prototype.asset = function (identifier, options, force) {
    options = options || {};

    //Have we already defined the asset?
    if (!force && identifier in this.pendingAssets) {
        var existingOptions = this.pendingAssets[identifier].options;
        options = utils.mergeDefaults(utils.copy(options), existingOptions);
        return this.asset(identifier, options, true);
    }

    if (this.options.separateBundles && options.include) {
        var include;
        try {
            include = this.expandGlobs(options.include);
        } catch (err) {
            message = err.message + format(' when building asset "%s"', identifier);
            this.emit('error', new Error(message));
            return '';
        }
        options = utils.copy(options);
        delete options.include;
        var self = this;
        return include.map(function (identifier) {
            return self.asset(identifier, options);
        }).join('\n');
    }

    var url = this.assetUrl(identifier, options);
    var extname = path.extname(url);
    if (!(extname in this.options.tags)) {
        var message = format('Unable to create an HTML tag for type "%s"', extname);
        this.emit('error', new Error(message));
        return '';
    }
    return this.options.tags[extname](url, this.options, options.attributes || {});
};

/**
 * Get the URL of a compiled asset.
 *
 * @param {String} identifier
 * @param {Object} options (optional)
 * @param {Boolean} force (optional) - ignore any existing asset definitions
 * @return {String} path
 */

Manager.prototype.assetUrl = function (identifier, options, force) {
    identifier = identifier.toLowerCase();
    //Have we already defined the asset?
    if (!force && identifier in this.pendingAssets) {
        var existingOptions = this.pendingAssets[identifier].options;
        options = utils.mergeDefaults(utils.copy(options), existingOptions);
        return this.assetUrl(identifier, options, true);
    }
    var url = this.assetPath(identifier, options);
    if (!url) {
        return '';
    }
    var prefix = this.options.urlPrefix || options.prefix;
    if (prefix) {
        if (url[0] === '/' && prefix[prefix.length - 1] === '/') {
            prefix = prefix.slice(0, -1);
        }
        url = prefix + url;
    }
    return url;
};

/**
 * Get the path of a compiled asset.
 *
 * @param {String} identifier
 * @param {Object} options (optional)
 * @param {Boolean} force (optional) - ignore any existing asset definitions
 * @return {String} path
 */

Manager.prototype.assetPath = function (identifier, options, force) {
    identifier = identifier.toLowerCase();

    //Let users define assets using a compiler extension, e.g. "foo.less"
    var dirname, extname = path.extname(identifier);
    if (extname in this.options.compilers) {
        dirname = identifier.indexOf('/') >= 0 ? path.dirname(identifier) : '';
        var outputExt = this.options.compilers[extname].output;
        identifier = path.join(dirname, path.basename(identifier, extname) + outputExt);
    }

    //Have we already defined the asset?
    options = options || {};
    if (!force && identifier in this.pendingAssets) {
        var existingOptions = this.pendingAssets[identifier].options;
        options = utils.mergeDefaults(utils.copy(options), existingOptions);
        return this.assetPath(identifier, options, true);
    }

    var filenames = []
      , dependencies = []
      , assets = []
      , message
      , self = this;

    //Is the asset a bundle?
    if (options.include) {
        try {
            filenames = filenames.concat(this.expandGlobs(options.include));
        } catch (err) {
            message = err.message + format(' when building asset "%s"', identifier);
            this.emit('error', new Error(message));
            return '';
        }
    } else {
        filenames.push(identifier);
    }

    filenames = utils.stripDuplicates(filenames);
    if (!filenames.length) {
        this.emit('error', new Error('No assets were defined'));
        return '';
    }

    var compilers, base, tried, foundUncompiled
      , uncompiledFilename;

    //Make sure each asset exists
    for (var filename, i = 0, len = filenames.length; i < len; i++) {
        filename = filenames[i].toLowerCase();

        //If the asset doesn't exist, check if one of the compilers claims it,
        //e.g. foo.css might exist as foo.less.
        if (!(filename in this.assets)) {
            extname = path.extname(filename);
            dirname = filename.indexOf(path.sep) >= 0 ? path.dirname(filename) : '';
            base = path.join(dirname, path.basename(filename, extname));
            compilers = this.reverseCompilerIndex[extname];
            foundUncompiled = tried = false;
            if (compilers) {
                tried = [];
                for (var compiler, j = 0; j < compilers.length; j++) {
                    compiler = compilers[j];
                    uncompiledFilename = base + compiler.extname;
                    if (uncompiledFilename === filename) {
                        continue;
                    }
                    if (uncompiledFilename in this.assets) {
                        foundUncompiled = true;
                        filename = uncompiledFilename;
                        break;
                    }
                    tried.push(uncompiledFilename);
                }
            }
            if (!foundUncompiled) {
                message = format('Asset "%s" could not be found', filename);
                if (options.include) {
                    message += format(' when building asset "%s"', identifier);
                }
                if (tried && tried.length) {
                    message += format(' (tried "%s")', tried.join('", "'));
                }
                this.emit('error', new Error(message));
                return '';
            }
        }
        assets.push(this.assets[filename]);
    }

    //Let the user specify a list of assets that are included in the final asset
    //thay we wouldn't otherwise know about (e.g. files included via an @import in less)
    if (options.dependencies) {
        try {
            var dependencyFilenames = this.expandGlobs(options.dependencies)
              , dependency, asset;
            dependencyFilenames = utils.stripDuplicates(dependencyFilenames);
            for (i = 0, len = dependencyFilenames.length; i < len; i++) {
                dependency = dependencyFilenames[i];
                asset = self.assets[dependency];
                if (!asset) {
                    throw new Error(format('Failed to locate "%s"', dependency));
                }
                dependencies.push(asset);
            }
        } catch (err) {
            message = format(' when finding dependencies for "%s"', identifier);
            this.emit('error', new Error(err.message + message));
            return '';
        }
    }

    //Generate a cache-busting hash based on the expected contents of the asset
    var assetHashes = assets.concat(dependencies).map(function (asset) {
        return asset.hash;
    }).join(':');
    var hash = utils.hashString(assetHashes, this.options.hash)
        .slice(0, this.options.hashLength);

    //Generate the output filename
    var canonical = path.basename(identifier)
      , assetDirname = identifier.indexOf('/') >= 0 ? path.dirname(identifier) : ''
      , assetFilename = path.join(assetDirname, this.getCompiledAssetFilename(canonical, hash))
      , assetPath = path.join(this.options.servePrefix, assetFilename);
    this.pendingAssets[identifier] = {
        path: assetPath
      , assets: assets
      , dependencies: dependencies
      , options: options
    };

    //Cleanup any older versions of the asset
    var existing = this.compiledAssets[identifier];
    if (existing) {
        this.compiledAssets[identifier] = existing.filter(function (file) {
            if (file !== assetFilename) {
                fs.unlink(path.join(self.dir, file), utils.noop);
                return false;
            }
            return true;
        });
    }

    return assetPath;
};

/**
 * Expand an array of glob patterns.
 *
 * @param {String|Array} glob(s)
 * @return {Array} files
 */

var isGlob = /[*?{}]/;

Manager.prototype.expandGlobs = function (globs) {
    if (!Array.isArray(globs)) {
        globs = [ globs ];
    }
    var filenames = [];
    for (var matched, filename, i = 0, len = globs.length; i < len; i++) {
        if (!isGlob.test(globs[i])) {
            filenames.push(globs[i]);
            continue;
        }
        matched = false;
        for (filename in this.assets) {
            if (minimatch(filename, globs[i])) {
                matched = true;
                filenames.push(filename);
            }
        }
        if (!matched) {
            throw new Error(format('No assets matched the pattern "%s"', globs[i]));
        }
    }
    return filenames;
};

/**
 * Watch the static directory for updates.
 */

Manager.prototype.watchDirectory = function () {
    var locations = [];
    for (var file in this.assets) {
        locations.push(path.dirname(file));
    }
    var self = this;
    this.watchers = utils.stripDuplicates(locations).map(function (dir) {
        return fs.watch(path.join(self.dir, dir), function (event, filename) {
            filename = path.join(dir, filename);
            if (self.isCompiledAsset(filename) || filename === self.options.manifest) {
                return;
            }
            var filePath = path.join(self.dir, filename)
              , canonical = filename.toLowerCase();
            try {
                var stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    self.removeWatchers();
                    self.indexAssets();
                    self.hashAssets();
                    self.watchDirectory();
                } else {
                    self.assets[canonical] = {
                        name: filename
                      , mtime: stat.mtime.getTime()
                      , hash: utils.hashFile(filePath, self.options.hash)
                    };
                }
            } catch (err) {
                delete self.assets[canonical];
            }
            self.writeManifest();
            self.emit('change', filename);
        });
    });
};

/**
 * Destroy the asset manager.
 */

Manager.prototype.destroy = function () {
    if (this.watchers) {
        this.removeWatchers();
    }
    this.initialised = false;
};

/**
 * Remove all directory watchers.
 */


Manager.prototype.removeWatchers = function () {
    this.watchers.forEach(function (watcher) {
        watcher.close();
    });
    this.watchers = [];
};

/**
 * Register a HTML tag format.
 *
 * @param {String} ext - e.g. ".js"
 * @param {Function} formatter
 * @return {Manager} this
 */

Manager.prototype.registerTag = function (ext, formatter) {
    ext = utils.toExtname(ext);
    this.options.tags[ext] = formatter;
    return this;
};

/**
 * Register a compressor.
 *
 * @param {String} ext - e.g. ".js"
 * @param {Function} compressor
 * @return {Manager} this
 */

Manager.prototype.registerCompressor = function (ext, compressor) {
    ext = utils.toExtname(ext);
    this.options.compressors[ext] = compressor;
    return this;
};

/**
 * Register a compiler.
 *
 * @param {String} inputExt - e.g. ".less"
 * @param {String} outputExt - e.g. ".css"
 * @param {Function} compiler
 * @return {Manager} this
 */

Manager.prototype.registerCompiler = function (inputExt, outputExt, compiler) {
    inputExt = utils.toExtname(inputExt);
    outputExt = utils.toExtname(outputExt);
    compiler = {
        output: outputExt
      , compile: compiler
      , extname: inputExt
    };
    this.options.compilers[inputExt] = compiler;
    if (outputExt in this.reverseCompilerIndex) {
        var compilers = this.reverseCompilerIndex[outputExt];
        this.reverseCompilerIndex[outputExt] = compilers.filter(function (compiler) {
            return compiler.extname !== inputExt;
        });
    } else {
        this.reverseCompilerIndex[outputExt] = [];
    }
    this.reverseCompilerIndex[outputExt].push(compiler);
    return this;
};

/**
 * Get a compiled asset filename.
 *
 * @param {String} filename
 * @param {String} hash
 * @return {String} filename
 */

Manager.prototype.getCompiledAssetFilename = function (filename, hash) {
    return format('%s-%s-%s', this.options.assetPrefix, hash, filename);
};

/**
 * Check whether a file is a compiled asset.
 *
 * @param {String} file
 * @return {Boolean}
 */

Manager.prototype.isCompiledAsset = function (file) {
    return this.compiledPattern.test(path.basename(file));
};

/**
 * Get the canonical path of a compiled asset.
 *
 * @param {String} file
 * @return {String}
 */

Manager.prototype.getCanonicalPath = function (file) {
    var dir = path.dirname(file)
      , filename = path.basename(file)
      , canonical = filename.split('-').slice(2).join('-');
    return path.join(dir, canonical);
};
