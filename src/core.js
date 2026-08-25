const path = require('path');
let http = require('http');
const URL = require('url');
const os = require('os');
const fs = require('fs-extra');
const exec = require('child_process').exec;
const spawn = require('child_process').spawn;

const downloadTimeout = 10000;
const checkTimeout = 1000;
const tempFolder = os.tmpdir();
let platform = process.platform;
platform = /^win/.test(platform) ? 'win' : /^darwin/.test(platform) ? 'mac' : 'linux' + (process.arch == 'ia32' ? '32' : '64');


module.exports = {
  manifest: null,
  DEBUG: true,

  // ----------------------------- Check online -----------------------------
  checkVersion: function (url, headers) {
    return new Promise(function (resolve, reject) {
      if (url.split("://")[0] == "https") http = require('https');
      else http = require('http');

      url = URL.parse(url);
      if (module.exports.DEBUG) console.log("[UPDATER] Getting new manifest:", url.href);
      const req = http.get(
        {
          hostname: url.hostname,
          path: url.path,
          method: 'GET',
          headers: headers,
          timeout: checkTimeout
        },
        function (res) {
          if (res.statusCode != 200) {
            reject(new Error("Error parsing new manifest :("));
          }

          var data = "";
          res.setEncoding('utf8');
          res.on('data', function (chunk) {
            data += chunk;
          });

          res.on('end', function () {
            try {
              var manifest = JSON.parse(data);
              module.exports.manifest = manifest;
              if (module.exports.DEBUG) console.log("[UPDATER] Got new manifest:", manifest);
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

      req.setTimeout(checkTimeout, function () {
        reject(new Error("Timeout"));
        req.abort();
      });

      req.end();
    });
  },


  // ----------------------------- Download -----------------------------
  download: function (newManifest, statusCallback) {
    return new Promise(function (resolve, reject) {
      var manifest = newManifest || this.manifest;
      var url = manifest.packages[platform].url;
      var filename = path.basename(url);
      var destinationPath = path.join(tempFolder, filename);
      var file = fs.createWriteStream(destinationPath);

      // If protocol is https
      if (url.split("://")[0] == "https") {
        http = require('https');
      }

      // Start downloading
      if (module.exports.DEBUG) console.log("[UPDATER] Started downloading:", url, " - to:", destinationPath);
      var downloadRequest = http.get(url).on('response', function (response) {
        if (response.statusCode != 200) {
          // Trow error if response is not 200 OK
          if (module.exports.DEBUG) console.error("[UPDATER] Download error:", response);
          reject(new Error(response));
          fs.remove(destinationPath);

        } else {
          // Get total size
          var size = parseInt(response.headers['content-length'], 10);
          var downloaded = 0;

          // Listen to request changes
          response.on('data', function (chunk) {
            file.write(chunk);

            // Callback download status
            downloaded += chunk.length;
            var status = {
              size: size,
              progress: (100.0 * downloaded / size).toFixed(2),
              bytes: downloaded
            };
            if (module.exports.DEBUG) console.log("[UPDATER] Download status:", status);
            statusCallback(status);

            // Reset timeout
            clearTimeout(timeoutId);
            timeoutId = setTimeout(fn, downloadTimeout);

          }).on('end', function () {
            // Clear timeout
            clearTimeout(timeoutId);

            // Return filename
            file.end();
            resolve(destinationPath);
            if (module.exports.DEBUG) console.log("[UPDATER] Download success:", destinationPath);

          }).on('error', function (err) {
            // Clear timeout
            clearTimeout(timeoutId);

            // Clean and return error
            fs.remove(destinationPath);
            reject(err);
            if (module.exports.DEBUG) console.error("[UPDATER] Download error:", err);
          });

          // Generate download timeout handler
          const fn = function () {
            downloadRequest.abort();
            fs.remove(destinationPath);
            reject(new Error("File transfer timeout!"));
          };
          let timeoutId = setTimeout(fn, downloadTimeout);
        }
      });
    });
  },


  // ----------------------------- Unpack -----------------------------
  unpack: function (fileToUnpack, manifest, statusCallback) {
    return new Promise(function (resolve, reject) {
      const destinationDirectory = module.exports.getZipDestinationDirectory(manifest.name);
      if (module.exports.DEBUG) console.log("[UPDATER] Unpacking:", fileToUnpack, "->", destinationDirectory);

      const unzipBin = platform == "win" ? path.resolve(__dirname, 'tools/unzip.exe') : 'unzip';

      // Count entries in the archive so progress can be reported as extractedFiles/totalFiles
      const getTotalFiles = function (callback) {
        exec('"' + unzipBin + '" -l "' + fileToUnpack + '"', function (err, stdout) {
          if (err) return callback(0);
          let total = 0;
          (stdout || "").split(/\r?\n/).forEach(function (line) {
            if (/^\s*\d+\s+[\d\-.]+\s+[\d:]+\s+\S/.test(line)) total++;
          });
          callback(total);
        });
      };

      const unzip = function () {
        getTotalFiles(function (totalFiles) {
          // Always extract into destinationDirectory - runInstaller() locates the
          // executable inside it via getExecPathRelativeToPackage() on every platform.
          const args = platform == "win"
            ? ['-u', '-o', fileToUnpack, '-d', destinationDirectory]
            : [fileToUnpack, '-d', destinationDirectory];

          if (module.exports.DEBUG) console.log("[UPDATER] Unpacking command:", unzipBin, args.join(' '));

          const child = spawn(unzipBin, args, {
            cwd: tempFolder
          });

          let extractedFiles = 0;
          let buffer = "";
          let stderr = "";

          child.stdout.on('data', function (chunk) {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            lines.forEach(function (line) {
              if (/(inflating|extracting|creating):/.test(line)) {
                extractedFiles++;
                const status = {
                  totalFiles: totalFiles,
                  extractedFiles: extractedFiles,
                  progress: totalFiles ? (100.0 * extractedFiles / totalFiles).toFixed(2) : 0,
                  file: line.split(':').slice(1).join(':').trim()
                };
                if (module.exports.DEBUG) console.log("[UPDATER] Unpack status:", status);
                if (statusCallback) statusCallback(status);
              }
            });
          });

          child.stderr.on('data', function (chunk) {
            stderr += chunk;
          });

          child.on('error', reject);
          child.on('close', function (code) {
            if (code) reject(new Error(stderr || ('unzip exited with code ' + code)));
            else resolve(destinationDirectory);
          });
        });
      };

      // Check if directory exists
      fs.exists(destinationDirectory, function (exists) {
        if (exists) {
          fs.remove(destinationDirectory).then(unzip, reject);
        } else {
          unzip();
        }
      });
    });
  },


  // -------------------------------------- Install --------------------------------------
  install: function (installDirectory) {
    return new Promise(function (resolve, reject) {
      if (module.exports.DEBUG) console.log("[UPDATER] Installing to:", installDirectory);
      if (module.exports.DEBUG) console.log("[UPDATER] Removing old node_modules:", installDirectory + "/node_modules/");
      fs.remove(installDirectory + "/node_modules/").then(function () {
        if (module.exports.DEBUG) console.log("[UPDATER] Copy '" + module.exports.getAppPath() + "' to '" + installDirectory + "'");
        fs.copy(module.exports.getAppPath(), installDirectory).then(function () {
          resolve(installDirectory);
        }, reject);
      }, reject);
    });
  },


  // -------------------------------------- Run installer --------------------------------------
  runInstaller: function (manifest) {
    const appPath = path.join(module.exports.getZipDestinationDirectory(manifest.name), module.exports.getExecPathRelativeToPackage(manifest));
    module.exports.run(appPath, [module.exports.getAppPath(), module.exports.getAppExec()], {});
  },


  // -------------------------------------- Run --------------------------------------
  run: function (appPath, args, options) {
    if (module.exports.DEBUG) console.log("[UPDATER] Run:", appPath);

    function run(path, args, options) {
      const opts = {
        detached: true
      };
      for (const key in options) {
        opts[key] = options[key];
      }
      return spawn(path, args, opts).unref();
    }

    if (platform == "mac") {
      if (args && args.length) args = [appPath].concat('--args', args);
      else args = [appPath];
      return run('open', args, options);

    } else if (platform == "win") {
      return run(appPath, args, options);

    } else if (platform == "linux32" || platform == "linux64") {
      fs.chmodSync(appPath, "0755");
      if (!options) options = {};
      options.cwd = appPath;
      return run(appPath, args, options);
    }
  },


  // -------------------------------------- App path --------------------------------------
  getAppPath: function () {
    const appPath = {
      mac: path.join(process.cwd(), '../../..'),
      win: path.dirname(process.execPath)
    };
    appPath.linux32 = appPath.win;
    appPath.linux64 = appPath.win;
    return appPath[platform];
  },


  // -------------------------------------- App exec --------------------------------------
  getAppExec: function () {
    const execFolder = module.exports.getAppPath();
    const exec = {
      mac: '',
      win: path.basename(process.execPath),
      linux32: path.basename(process.execPath),
      linux64: path.basename(process.execPath)
    };
    return path.join(execFolder, exec[platform]);
  },


  // -------------------------------------- Get zip destination --------------------------------------
  getZipDestinationDirectory: function (name) {
    return path.join(tempFolder, path.basename(name));
  },


  // -------------------------------------- Get exec path relative to package --------------------------------------
  getExecPathRelativeToPackage: function (manifest) {
    const execPath = manifest.packages[platform] && manifest.packages[platform].execPath;
    if (execPath) {
      return execPath;
    } else {
      const suffix = {
        win: '.exe',
        mac: '.app'
      };
      return manifest.name + (suffix[platform] || '');
    }
  },


  // -------------------------------------- Compare versions --------------------------------------
  isThereNewVersion: function (v1, v2) {
    if (v1[0] == "v") v1 = v1.substring(1);
    if (v2[0] == "v") v2 = v2.substring(1);
    const v1parts = v1.split('.');
    const v2parts = v2.split('.');
    const maxLen = Math.max(v1parts.length, v2parts.length);
    let part1, part2;
    let cmp = 0;

    for (let i = 0; i < maxLen && !cmp; i++) {
      part1 = parseInt(v1parts[i], 10) || 0;
      part2 = parseInt(v2parts[i], 10) || 0;
      if (part1 < part2)
        cmp = 1;
      if (part1 > part2)
        cmp = -1;
    }

    if (module.exports.DEBUG) {
      if (eval('0' + "<" + cmp)) console.log("[UPDATER] New version available!:", v1, "<", v2);
      else console.log("[UPDATER] No new version:", v1, ">", v2);
    }

    return eval('0' + "<" + cmp);
  }
};