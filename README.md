# NWJS Updater v0.0.15

Self-update helper for [NW.js](https://nwjs.io/) apps. It checks a remote manifest for a newer version, downloads the platform-specific package, unpacks it, and installs it over the running app.

## Install

```bash
npm install olaii-nwjs-updater
```

## Usage

```js
const updater = require("olaii-nwjs-updater");
const package = require("../package.json");

const url = "https://example.com/package.json"; // remote manifest URL
const headers = {}; // optional request headers, e.g. auth tokens

// 1. Fetch the remote manifest
updater.checkVersion(url, headers).then(function (newManifest) {

  // 2. Compare against the running app"s version
  if (updater.isThereNewVersion(package.version, newManifest.version)) {

    // 3. Download the platform-specific package
    updater.download(newManifest, function (downloadStatus) {
      // { size, progress, bytes }
    }).then(function (downloadedFile) {

      // 4. Unpack it
      updater.unpack(downloadedFile, newManifest, function (unpackStatus) {
        // { totalFiles, extractedFiles, progress, file }
      }).then(function () {

        // 5. Launch the unpacked installer, which installs itself
        //    over the running app and relaunches it
        updater.runInstaller(newManifest);
      }, function (error) {
        console.error(error);
      });

    }, function (error) {
      console.error(error);
    });

  } else {
    console.error("No new update!");
  }
}, function (error) {
  console.error("Cannot fetch new manifest:", error);
});
```

See [examples/example.js](examples/example.js) for a full end-to-end flow, including the code that runs inside the downloaded update package to install itself over the original app.

## Manifest format

`checkVersion` expects the remote URL to return JSON shaped like:

```json
{
  "name": "example",
  "version": "0.0.0",
  "author": "example",
  "manifestUrl": "https://example/package.json",
  "changelog": "Multiline changelog",
  "packages": {
    "mac": {
      "url": "https://example/update.zip"
    },
    "win": {
      "url": "https://example/update.zip"
    },
    "linux": {
      "url": "https://example/update.zip"
    }
  }
}
```

`execPath` is optional per platform; when omitted it defaults to `<name>.exe` on Windows or `<name>.app` on macOS.

## API

- `checkVersion(url, headers)` — fetches and returns the remote manifest, storing it on `updater.manifest`.

- `isThereNewVersion(currentVersion, newVersion)` — compares two version strings, returns `true` if the second is newer.

- `download(manifest, statusCallback)` — downloads the platform"s package to the OS temp folder. `statusCallback` receives `{ size, progress, bytes }`.

- `unpack(fileToUnpack, manifest, statusCallback)` — extracts the downloaded zip. `statusCallback` receives `{ totalFiles, extractedFiles, progress, file }`.

- `install(installDirectory)` — replaces `installDirectory`"s `node_modules` with a copy of the currently running app.

- `runInstaller(manifest)` — launches the unpacked package"s executable, passing it the current app"s path so it can install itself.

- `run(appPath, args, options)` — spawns a detached process for `appPath`.
- `getAppPath()` / `getAppExec()` — resolve the currently running app"s directory / executable path.

Set `updater.DEBUG = false` to silence console logging (enabled by default).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

See [LICENSE](LICENSE).
