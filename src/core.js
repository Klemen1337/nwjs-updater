var path = require('path');
var http = require('http');
var URL = require('url');
var os = require('os');
var fs = require('fs-extra');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var timeout = 10000;
var tempFolder = os.tmpdir();
var platform = process.platform;
platform = /^win/.test(platform)? 'win' : /^darwin/.test(platform)? 'mac' : 'linux' + (process.arch == 'ia32' ? '32' : '64');


module.exports = {
  manifest: null,
  DEBUG: true,

  // ----------------------------- Check online -----------------------------
  checkVersion: function(url, headers){   
    return new Promise(function(resolve, reject){
      if(url.split("://")[0] == "https") http = require('https');
      else http = require('http');

      url = URL.parse(url);
      if(module.exports.DEBUG) console.log("[UPDATER] Getting new manifest:", url.href);
      var req = http.get(
        {
          hostname: url.hostname,
          path: url.path,
          method: 'GET',
          headers: headers
        }, 
        function(res){
          if(res.statusCode != 200) {
            reject(new Error("Error parsing new manifest :("));
          }

          var data = "";
          res.setEncoding('utf8');
          res.on('data', function(chunk) {
            data += chunk;
          });

          res.on('end', function() {
            try {
              var manifest = JSON.parse(data);
              module.exports.manifest = manifest;
              if(module.exports.DEBUG) console.log("[UPDATER] Got new manifest:", manifest);
              resolve(manifest);
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on('error', function (e) {
        reject(e);
      });

      req.on('timeout', function () {
        reject(new Error("Timeout"));
        req.abort();
      });

      req.setTimeout(2000);
      req.end();
    });
  },


  // ----------------------------- Download -----------------------------
  download: function(newManifest, statusCallback){
    return new Promise(function(resolve, reject){
      var manifest = newManifest || this.manifest;
      var url = manifest.packages[platform].url;
      var filename = path.basename(url);
      var destinationPath = path.join(tempFolder, filename);
      var file = fs.createWriteStream(destinationPath);
    
      // If protocol is https
      if(url.split("://")[0] == "https"){
        http = require('https');
      }
    
      // Start downloading
      if(module.exports.DEBUG)  console.log("[UPDATER] Started downloading:", url, " - to:", destinationPath);
      var downloadRequest = http.get(url).on('response', function(response) {
        if(response.statusCode != 200){
          // Trow error if response is not 200 OK
          if(module.exports.DEBUG) console.error("[UPDATER] Download error:", response);
          reject(new Error(response));
          fs.remove(destinationPath);

        } else {
          // Get total size
          var size = parseInt(response.headers['content-length'], 10);
          var downloaded = 0;
    
          // Listen to request changes
          response.on('data', function(chunk) {
            file.write(chunk);
            
            // Callback download status
            downloaded += chunk.length;
            var status = {
              size: size,
              progress: (100.0 * downloaded / size).toFixed(2),
              bytes: downloaded
            };
            if(module.exports.DEBUG) console.log("[UPDATER] Download status:", status);
            statusCallback(status);          

            // Reset timeout
            clearTimeout(timeoutId);
            timeoutId = setTimeout(fn, timeout);
    
          }).on('end', function () {
            // Clear timeout
            clearTimeout(timeoutId);

            // Return filename
            file.end();
            resolve(destinationPath);
            if(module.exports.DEBUG) console.log("[UPDATER] Download success:", destinationPath);
    
          }).on('error', function (err) {
            // Clear timeout
            clearTimeout(timeoutId);

            // Clean and return error
            fs.remove(destinationPath);
            reject(err);
            if(module.exports.DEBUG) console.error("[UPDATER] Download error:", err);
          });
    
          // Generate download timeout handler
          var fn = function() {
            downloadRequest.abort();
            fs.remove(destinationPath);
            reject(new Error("File transfer timeout!"));
          };
          var timeoutId = setTimeout(fn, timeout);
        }
      });
    });
  },


  // ----------------------------- Unpack -----------------------------
  unpack: function(fileToUnpack, manifest){
    return new Promise(function(resolve, reject){
      var destinationDirectory = module.exports.getZipDestinationDirectory(manifest.name);
      if(module.exports.DEBUG) console.log("[UPDATER] Unpacking:", fileToUnpack , "->", destinationDirectory);

      var unzip = function(){
        var command = "";
        if(platform == "win"){
          command = '"' + path.resolve(__dirname, 'tools/unzip.exe') + '" -u -o "' + fileToUnpack + '" -d "' + destinationDirectory + '" > NUL';
        } else if(platform == "linux32" || platform == "linux64") {
          command = 'unzip "' + fileToUnpack + '" -d "' + module.exports.getExecPathRelativeToPackage(manifest) + '" > /dev/null';
        } else if(platform == "mac"){
          command = 'unzip "' + fileToUnpack + '" -d "' + destinationDirectory + '" > /tmp/unpacking.txt';
        }

        if(module.exports.DEBUG) console.log("[UPDATER] Unpacking command:", command);
        exec(command, {cwd: tempFolder}, function(err){
          if(err) reject(err);
          else resolve(destinationDirectory);
        });
      };

      // Check if directory exists
      fs.exists(destinationDirectory, function(exists){
        if(exists) {
          fs.remove(destinationDirectory).then(unzip, reject);
        } else {
          unzip();
        }
      });
    });
  },


  // -------------------------------------- Install --------------------------------------
  install: function(installDirectory){
    return new Promise(function(resolve, reject){
      if(module.exports.DEBUG) console.log("[UPDATER] Installing to:", installDirectory);
      if(module.exports.DEBUG) console.log("[UPDATER] Removing old node_modules:", installDirectory + "/node_modules/");
      fs.remove(installDirectory + "/node_modules/").then(function() {
        if(module.exports.DEBUG) console.log("[UPDATER] Copy '" + module.exports.getAppPath() + "' to '" + installDirectory + "'");
        fs.copy(module.exports.getAppPath(), installDirectory).then(function(){
          resolve(installDirectory);
        }, reject);
      }, reject);
    });
  },


  // -------------------------------------- Run installer --------------------------------------
  runInstaller: function(manifest){
    var appPath = path.join(module.exports.getZipDestinationDirectory(manifest.name), module.exports.getExecPathRelativeToPackage(manifest));
    module.exports.run(appPath, [module.exports.getAppPath(), module.exports.getAppExec()], {});
  },


  // -------------------------------------- Run --------------------------------------
  run: function(appPath, args, options){
    if(module.exports.DEBUG) console.log("[UPDATER] Run:", appPath);
    function run(path, args, options){
      var opts = { detached: true };
      for(var key in options){ opts[key] = options[key]; }
      return spawn(path, args, opts).unref();
    }

    if(platform == "mac"){
      if(args && args.length) args = [appPath].concat('--args', args);
      else args = [appPath];
      return run('open', args, options);

    } else if(platform == "win"){
      return run(appPath, args, options);

    } else if(platform == "linux32" || platform == "linux64"){
      fs.chmodSync(appPath, 0755);
      if(!options) options = {};
      options.cwd = appPath;
      return run(appPath, args, options);
    }
  },


  // -------------------------------------- App path --------------------------------------
  getAppPath: function(){
    var appPath = {
      mac: path.join(process.cwd(),'../../..'),
      win: path.dirname(process.execPath)
    };
    appPath.linux32 = appPath.win;
    appPath.linux64 = appPath.win;
    return appPath[platform];
  },


  // -------------------------------------- App exec --------------------------------------
  getAppExec: function(){
    var execFolder = module.exports.getAppPath();
    var exec = {
      mac: '',
      win: path.basename(process.execPath),
      linux32: path.basename(process.execPath),
      linux64: path.basename(process.execPath)
    };
    return path.join(execFolder, exec[platform]);
  },


  // -------------------------------------- Get zip destination --------------------------------------
  getZipDestinationDirectory: function(name){
    return path.join(tempFolder, path.basename(name));
  },


  // -------------------------------------- Get exec path relative to package --------------------------------------
  getExecPathRelativeToPackage: function(manifest){
    var execPath = manifest.packages[platform] && manifest.packages[platform].execPath;
    if(execPath) {
      return execPath;
    } else {
      var suffix = {
        win: '.exe',
        mac: '.app'
      };
      return manifest.name + (suffix[platform] || '');
    }
  },


  // -------------------------------------- Compare versions --------------------------------------
  isThereNewVersion: function(v1, v2){
    if(v1[0] == "v") v1 = v1.substring(1);
    if(v2[0] == "v") v2 = v2.substring(1);
    var v1parts = v1.split('.');
    var v2parts = v2.split('.');
    var maxLen = Math.max(v1parts.length, v2parts.length);
    var part1, part2;
    var cmp = 0;
  
    for(var i = 0; i < maxLen && !cmp; i++) {
      part1 = parseInt(v1parts[i], 10) || 0;
      part2 = parseInt(v2parts[i], 10) || 0;
      if(part1 < part2)
        cmp = 1;
      if(part1 > part2)
        cmp = -1;
    }

    if(module.exports.DEBUG) {
      if(eval('0' + "<" + cmp)) console.log("[UPDATER] New version avaliable!:", v1, "<", v2);
      else console.log("[UPDATER] No new version:", v1, ">", v2);
    }
     
    return eval('0' + "<" + cmp);
  }
};