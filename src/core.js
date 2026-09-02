let http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const spawn = require('child_process').spawn;


const service = {
  manifest: null,
  DEBUG: true,

  downloadTimeout: 10000,
  checkTimeout: 1000,
  tempFolder: os.tmpdir(),
  platform: /^win/.test(process.platform) ? 'win' : /^darwin/.test(process.platform) ? 'mac' : 'linux' + (process.arch == 'ia32' ? '32' : '64'),

  // ----------------------------- Check online -----------------------------
  /**
   * Fetches the remote manifest and stores it on `service.manifest`.
   * @param {string} url - URL of the manifest JSON file.
   * @param {Object} [headers] - Request headers to send with the GET request.
   * @returns {Promise<Object>} Resolves with the parsed manifest object.
   */
  checkVersion: function (url, headers) {
    return new Promise(function (resolve, reject) {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol == "https:") http = require('https');
      else http = require('http');

      if (service.DEBUG) console.log("[UPDATER] Getting new manifest:", parsedUrl.href);
      const req = http.get(
        {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname,
          method: 'GET',
          headers: headers,
          timeout: service.checkTimeout
        },
        function (res) {
          if (res.statusCode != 200) {
            reject(new Error("Error parsing new manifest :("));
          }

          let data = "";
          res.setEncoding('utf8');
          res.on('data', function (chunk) {
            data += chunk;
          });

          res.on('end', function () {
            try {
              const manifest = JSON.parse(data);
              service.manifest = manifest;
              if (service.DEBUG) console.log("[UPDATER] Got new manifest:", manifest);
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
        req.destroy();
      });

      req.setTimeout(service.checkTimeout, function () {
        reject(new Error("Timeout"));
        req.destroy();
      });

      req.end();
    });
  },


  // ----------------------------- Download -----------------------------
  /**
   * Downloads the platform-specific package referenced by the manifest into the OS temp folder.
   * @param {Object} [newManifest] - Manifest to download from; defaults to `this.manifest`.
   * @param {function(Object): void} statusCallback - Called with `{size, progress, bytes}` on each chunk received.
   * @returns {Promise<string>} Resolves with the path of the downloaded file.
   */
  download: function (newManifest, statusCallback) {
    return new Promise(function (resolve, reject) {
      const manifest = newManifest || this.manifest;
      const url = manifest.packages[service.platform].url;
      const filename = path.basename(url);
      const destinationPath = path.join(service.tempFolder, filename);
      const file = fs.createWriteStream(destinationPath);

      // If protocol is https
      if (url.split("://")[0] == "https") {
        http = require('https');
      }

      // Start downloading
      if (service.DEBUG) console.log("[UPDATER] Started downloading:", url, " - to:", destinationPath);
      const downloadRequest = http.get(url).on('response', function (response) {
        if (response.statusCode != 200) {
          // Trow error if response is not 200 OK
          if (service.DEBUG) console.error("[UPDATER] Download error:", response);
          reject(new Error(response));
          fs.remove(destinationPath);

        } else {
          // Get total size
          const size = parseInt(response.headers['content-length'], 10);
          let downloaded = 0;
          let oldProgress = 0;

          // Listen to request changes
          response.on('data', function (chunk) {
            file.write(chunk);

            // Callback download status
            downloaded += chunk.length;
            const progress = parseInt((100.0 * downloaded / size).toFixed(0));
            const status = {
              size: size,
              progress: progress,
              bytes: downloaded
            };
            
            if (statusCallback && progress != oldProgress) {
              if (service.DEBUG) console.log("[UPDATER] Download status:", status);
              statusCallback(status);
              oldProgress = parseInt(progress);
            }

            // Reset timeout
            clearTimeout(timeoutId);
            timeoutId = setTimeout(fn, service.downloadTimeout);

          }).on('end', function () {
            // Clear timeout
            clearTimeout(timeoutId);

            // Return filename
            file.end();
            resolve(destinationPath);
            if (service.DEBUG) console.log("[UPDATER] Download success:", destinationPath);

          }).on('error', function (err) {
            // Clear timeout
            clearTimeout(timeoutId);

            // Clean and return error
            fs.remove(destinationPath);
            reject(err);
            if (service.DEBUG) console.error("[UPDATER] Download error:", err);
          });

          // Generate download timeout handler
          const fn = function () {
            downloadRequest.destroy();
            fs.remove(destinationPath);
            reject(new Error("File transfer timeout!"));
          };
          let timeoutId = setTimeout(fn, service.downloadTimeout);
        }
      });
    });
  },


  // ----------------------------- Unpack -----------------------------
  /**
   * Extracts a downloaded zip package into the destination directory for the given manifest.
   * @param {string} fileToUnpack - Path to the downloaded zip file.
   * @param {Object} manifest - Manifest describing the package (used to derive the destination directory).
   * @param {function(Object): void} [statusCallback] - Called with `{totalFiles, extractedFiles, progress, file}` as entries are extracted.
   * @returns {Promise<string>} Resolves with the destination directory path.
   */
  unpack: function (fileToUnpack, manifest, statusCallback) {
    return new Promise(function (resolve, reject) {
      const destinationDirectory = service.getZipDestinationDirectory(manifest.name);
      if (service.DEBUG) console.log("[UPDATER] Unpacking:", fileToUnpack, "->", destinationDirectory);

      const unzipBin = service.platform == "win" ? path.resolve(__dirname, 'tools/unzip.exe') : 'unzip';

      // Count entries in the archive so progress can be reported as extractedFiles/totalFiles.
      // Read the count straight out of the ZIP's End Of Central Directory record instead of
      // parsing `unzip -l` text output, whose column widths/date format vary between unzip
      // builds (this is what made Windows always report 0 total files, hence 0% progress).
      const getTotalFiles = function (callback) {
        const eocdSize = 22;
        const maxCommentSize = 65535;

        fs.stat(fileToUnpack, function (err, stats) {
          if (err) return callback(0);

          const readSize = Math.min(stats.size, eocdSize + maxCommentSize);
          const buffer = Buffer.alloc(readSize);

          fs.open(fileToUnpack, 'r', function (err, fd) {
            if (err) return callback(0);
            fs.read(fd, buffer, 0, readSize, stats.size - readSize, function (err) {
              fs.close(fd, function () { });
              if (err) return callback(0);

              // Scan backwards for the EOCD signature (0x06054b50, little-endian)
              for (let i = readSize - eocdSize; i >= 0; i--) {
                if (buffer.readUInt32LE(i) === 0x06054b50) {
                  return callback(buffer.readUInt16LE(i + 10));
                }
              }
              callback(0);
            });
          });
        });
      };

      const unzip = function () {
        getTotalFiles(function (totalFiles) {
          // Always extract into destinationDirectory - runInstaller() locates the
          // executable inside it via getExecPathRelativeToPackage() on every platform.
          const args = service.platform == "win"
            ? ['-u', '-o', fileToUnpack, '-d', destinationDirectory]
            : [fileToUnpack, '-d', destinationDirectory];

          if (service.DEBUG) console.log("[UPDATER] Unpacking command:", unzipBin, args.join(' '));

          const child = spawn(unzipBin, args, {
            cwd: service.tempFolder
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
                const progress = totalFiles ? (100.0 * extractedFiles / totalFiles).toFixed(2) : 0;
                const status = {
                  totalFiles: totalFiles,
                  extractedFiles: extractedFiles,
                  progress: progress,
                  file: line.split(':').slice(1).join(':').trim()
                };
                if (service.DEBUG) console.log("[UPDATER] Unpack status:", status);
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
  /**
   * Replaces the app's `node_modules` at `installDirectory` with a copy of the currently running app.
   * @param {string} installDirectory - Directory of the original app installation to update.
   * @returns {Promise<string>} Resolves with `installDirectory` once the copy completes.
   */
  install: function (installDirectory) {
    return new Promise(function (resolve, reject) {
      if (service.DEBUG) console.log("[UPDATER] Installing to:", installDirectory);
      if (service.DEBUG) console.log("[UPDATER] Removing old node_modules:", installDirectory + "/node_modules/");
      fs.remove(installDirectory + "/node_modules/").then(function () {
        if (service.DEBUG) console.log("[UPDATER] Copy '" + service.getAppPath() + "' to '" + installDirectory + "'");
        fs.copy(service.getAppPath(), installDirectory).then(function () {
          resolve(installDirectory);
        }, reject);
      }, reject);
    });
  },


  // -------------------------------------- Run installer --------------------------------------
  /**
   * Launches the unpacked update package's executable, passing along the current app's
   * path and executable so it can install itself over the running app.
   * @param {Object} manifest - Manifest describing the unpacked package.
   * @returns {void}
   */
  runInstaller: function (manifest) {
    const appPath = path.join(service.getZipDestinationDirectory(manifest.name), service.getExecPathRelativeToPackage(manifest));
    return service.run(appPath, [service.getAppPath(), service.getAppExec()], {});
  },


  // -------------------------------------- Run --------------------------------------
  /**
   * Spawns a detached process for `appPath`, using the platform-appropriate launch strategy
   * (macOS uses `open`, Windows/Linux spawn the executable directly).
   * @param {string} appPath - Path of the executable/app to launch.
   * @param {string[]} [args] - Arguments to pass to the executable.
   * @param {Object} [options] - Extra options merged into the `child_process.spawn` options.
   * @returns {ChildProcess} The unref'd spawned child process.
   */
  run: function (appPath, args, options) {
    function run(path, args, options) {
      const opts = {
        detached: true
      };
      for (const key in options) {
        opts[key] = options[key];
      }
      if (service.DEBUG) console.log("[UPDATER] Run:", appPath, args, opts);
      const child = spawn(path, args, opts);
      child.unref();
      return child;
    }

    if (service.platform == "mac") {
      if (args && args.length) args = [appPath].concat('--args', args);
      else args = [appPath];
      return run('open', args, options);

    } else if (service.platform == "win") {
      return run(appPath, args, options);

    } else if (service.platform == "linux32" || service.platform == "linux64") {
      fs.chmodSync(appPath, "0755");
      if (!options) options = {};
      options.cwd = path.dirname(appPath);
      return run(appPath, args, options);
    }
  },


  // -------------------------------------- App path --------------------------------------
  /**
   * Returns the directory of the currently running app (three levels up from cwd on macOS,
   * the executable's directory on Windows/Linux).
   * @returns {string} Path to the running app's directory.
   */
  getAppPath: function () {
    const appPath = {
      mac: path.join(process.cwd(), '../../..'),
      win: path.dirname(process.execPath)
    };
    appPath.linux32 = appPath.win;
    appPath.linux64 = appPath.win;
    return appPath[service.platform];
  },


  // -------------------------------------- App exec --------------------------------------
  /**
   * Returns the full path to the currently running app's executable.
   * @returns {string} Path to the app executable (empty basename on macOS, since it's a bundle).
   */
  getAppExec: function () {
    const execFolder = service.getAppPath();
    const exec = {
      mac: '',
      win: path.basename(process.execPath),
      linux32: path.basename(process.execPath),
      linux64: path.basename(process.execPath)
    };
    return path.join(execFolder, exec[service.platform]);
  },


  // -------------------------------------- Get zip destination --------------------------------------
  /**
   * Builds the extraction destination directory for a package, inside the OS temp folder.
   * @param {string} name - Package name (typically `manifest.name`).
   * @returns {string} Destination directory path.
   */
  getZipDestinationDirectory: function (name) {
    return path.join(service.tempFolder, path.basename(name));
  },


  // -------------------------------------- Get exec path relative to package --------------------------------------
  /**
   * Resolves the executable path within an unpacked package, relative to its package folder.
   * Uses `manifest.packages[platform].execPath` when set, otherwise falls back to
   * `manifest.name` plus the platform's default extension (`.exe` / `.app`).
   * @param {Object} manifest - Manifest describing the package.
   * @returns {string} Executable path relative to the package's destination directory.
   */
  getExecPathRelativeToPackage: function (manifest) {
    const execPath = manifest.packages[service.platform] && manifest.packages[service.platform].execPath;
    if (execPath) {
      return execPath;
    } else {
      const suffix = {
        win: '.exe',
        mac: '.app'
      };
      return manifest.name + (suffix[service.platform] || '');
    }
  },


  // -------------------------------------- Compare versions --------------------------------------
  /**
   * Compares two semver-like version strings (optionally prefixed with "v").
   * @param {string} v1 - Current version.
   * @param {string} v2 - Candidate version to compare against.
   * @returns {boolean} `true` if `v2` is newer than `v1`.
   */
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

    const hasNewVersion = eval('0' + "<" + cmp);

    if (service.DEBUG) {
      if (hasNewVersion) console.log("[UPDATER] New version available!:", v1, "<", v2);
      else console.log("[UPDATER] No new version:", v1, ">", v2);
    }

    return hasNewVersion;
  }
};

module.exports = service;