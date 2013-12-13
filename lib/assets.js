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
  , tags = require('./tags');

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
  , tagFormats: tags
  , html5: false
};

/**
 * Create a new AssetManager instance.
 *
 * @param {String} dir - the directory where static assets live
 * @param {Object} options (optional)
 */

function AssetManager(dir, options) {
    this.dir = dir;
    this.options = utils.mergeDefaults(options, defaultOptions);
    this.compiledPattern = new RegExp(format('^%s-%s-',
        utils.escapeRegex(this.options.assetPrefix)
      , '[0-9a-f]+?'
    ));
    this.assets = {};
    this.compiledAssets = {};
    this.pendingAssets = {};
}

inherits(AssetManager, EventEmitter);

exports.AssetManager = AssetManager;

/**
 * Initialse the asset manager and bind it to an express app.
 *
 * @param {Express} app
 */

AssetManager.prototype.init = function (app) {
    this.indexAssets();
    this.hashAssets();
    var helperName = this.options.viewHelper
      , helper = this.asset.bind(this)
      , self = this;
    var staticAssets = express.static(this.dir, {
        maxAge: this.options.maxAge
    });
    app.use(this.options.servePrefix, staticAssets);
    app.use(function (request, response, next) {
        response.locals[helperName] = helper;
        next();
    });
    app.use(this.options.servePrefix, function (request, response, next) {
        if (!self.isCompiledAsset(request.url)) {
            return next();
        }
        var canonical = self.getCanonicalName(request.url).slice(1)
          , asset = self.pendingAssets[canonical];
        if (!asset) {
            return next();
        }
        self.compileAsset(asset, next);
    });
    app.use(this.options.servePrefix, staticAssets);
};

/**
 * Compile an asset and write it to the static directory.
 *
 * @param {Object} file
 * @param {Function} callback
 */

AssetManager.prototype.compileAsset = function (file, callback) {
    var contents = [], self = this;
    async.eachSeries(file.assets, function (asset, next) {
        var assetPath = path.join(self.dir, asset.name);
        //TODO: Compile?
        fs.readFile(assetPath, function (err, buffer) {
            if (err) return next(err);
            contents.push(buffer.toString());
            next();
        });
    }, function (err) {
        if (err) return callback(err);
        contents = contents.join('\n');
        //TODO: Compress?
        var outputPath = path.join(self.dir, file.path);
        fs.writeFile(outputPath, contents, callback);
    });
};

/**
 * Index the directory of static assets.
 */

AssetManager.prototype.indexAssets = function () {
    var self = this;
    this.getAssets().forEach(function (file) {
        if (self.isCompiledAsset(file.name)) {
            var canonical = self.getCanonicalName(file.name);
            if (!(canonical in self.compiledAssets)) {
                self.compiledAssets[canonical] = [];
            }
            self.compiledAssets[canonical].push(file.name);
        } else if (file.name !== self.options.manifest) {
            self.assets[file.name] = file;
        }
    });
};

/**
 * Get a list of all static assets and their mtimes.
 *
 * @return {Array} files
 */

AssetManager.prototype.getAssets = function () {
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
 */

AssetManager.prototype.hashAssets = function () {
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
        try {
            fs.writeFileSync(manifestPath, JSON.stringify(this.assets));
        } catch (err) {
            var message = 'Failed to write the assets manifest: ' + err.toString();
            this.emit('error', new Error(message));
        }
    }
    return outdated;
};

/**
 * Define assets and return the resulting tags.
 *
 * This function also serves as the view helper available to templates.
 *
 * @param {String} identifier
 * @param {Object} options (optional)
 * @return {String} html
 */

AssetManager.prototype.asset = function (identifier, options) {
    options = options || {};
    var url = this.assetPath(identifier, options);
    if (!url) {
        return '';
    }
    if (options.prefix) {
        if (url[0] === '/' && options.prefix[options.prefix.length - 1] === '/') {
            options.prefix = options.prefix.slice(0, -1);
        }
        url = options.prefix + url;
    }
    var extname = path.extname(url);
    if (!(extname in this.options.tagFormats)) {
        var message = format('Unable to create an HTML tag for type "%s"', extname);
        this.emit('error', new Error(message));
        return '';
    }
    return this.options.tagFormats[extname](url, this.options, options.attributes || {});
};

/**
 * Generate an asset filename and return the asset's path.
 *
 * @param {String} identifier
 * @param {Object} options (optional)
 * @return {String} filename
 */

AssetManager.prototype.assetPath = function (identifier, options) {
    if (identifier in this.pendingAssets) {
        return this.pendingAssets[identifier].path;
    }
    options = options || {};
    var filenames = []
      , assets = []
      , message;

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

    //TODO: Add options.dependencies to the list

    filenames = utils.stripDuplicates(filenames);
    if (!filenames.length) {
        this.emit('error', new Error('No assets were defined'));
        return '';
    }

    //Make sure each asset exists
    for (var filename, i = 0, len = filenames.length; i < len; i++) {
        filename = filenames[i];
        if (!(filenames[i] in this.assets)) {

            //TODO: Check compilers, since foo.css might actually compile foo.less

            message = format('Asset "%s" could not be found', filename);
            if (options.include) {
                message += format(' when building asset "%s"', identifier);
            }
            this.emit('error', new Error(message));
            return '';
        }
        assets.push(this.assets[filename]);
    }

    //Generate a cache-busting hash based on each file's contents
    var assetHashes = assets.map(function (asset) {
        return asset.hash;
    }).join(':');
    var hash = utils.hashString(assetHashes, this.options.hash)
        .slice(0, this.options.hashLength);

    var assetPath = format('%s-%s-%s', this.options.assetPrefix, hash, identifier);
    assetPath = path.join(this.options.servePrefix, assetPath);
    this.pendingAssets[identifier] = {
        path: assetPath
      , assets: assets
    };
    return assetPath;
};

/**
 * Expand an array of glob patterns.
 *
 * @param {String|Array} glob(s)
 * @return {Array} files
 */

var isGlob = /[*?{}]/;

AssetManager.prototype.expandGlobs = function (globs) {
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
 * Check whether a file is a compiled asset.
 *
 * @param {String} file
 */

AssetManager.prototype.isCompiledAsset = function (file) {
    return this.compiledPattern.test(path.basename(file));
};

/**
 * Get the canonical name of a compiled asset.
 *
 * @param {String} file
 * @return {String} canonicalFilename
 */

AssetManager.prototype.getCanonicalName = function (file) {
    var dir = path.dirname(file)
      , filename = path.basename(file)
      , canonical = filename.split('-').slice(2).join('-');
    return path.join(dir, canonical);
};
