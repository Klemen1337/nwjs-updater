const updater = require('../nwjs-updater');
const package = require('../package.json');

const url = "https://pos.dev.olaii.com/api/v1/registers/misc/package.json";
const headers = {
  "Authorization": "RegisterToken VxwwiqQwzyqLhpaZTMV0nBI5ZFiIkjvzoLL3Q7pwY9ysZxlYjwymTKAvHj1GnIyyo",
  "Content-Type": "application/json",
  "X-PosId": "krneki",
}

const args = updater.getArgs();
console.log("[UPDATER] Parsed arguments:", );


async function runUpdater() {
  // ------------------ 1 ------------------
  try {
    const newManifest = await updater.checkVersion(url, headers);

    // ------------------ 2 ------------------
    if (!updater.isThereNewVersion(package.version, newManifest.version)) {
      throw console.error("No new update!");
    }

    // ------------------ 3 ------------------
    const downloadResponse = await updater.download(newManifest, function (downloadStatus) {
      // Download status
    });

    // ------------------ 4 ------------------
    const unpackResponse = await updater.unpack(downloadResponse, newManifest, function (unpackStatus) {
      // Unpack status
    });

    // ------------------ 5 ------------------
    updater.runInstaller(newManifest);
  } catch (error) {
    console.error("Error:", error);
  }
}


async function runInInstaller () {
  if (process.argv.length > 2) {
    // ------------- 6 -------------
    copyPath = args.appPath;
    execPath = args.appExec;

    // Replace old app, Run updated app from original location and close temp instance
    await updater.install(copyPath, process.pid, function (installStatus) {
      // Install status
    });

    // ------------- 7 -------------
    const runArgs = updater.packArgs({
      action: "UPDATED"
    });
    const client = updater.run(execPath, runArgs);
    client.on('spawn', function () {
      gui.App.quit();
    });
  } else {
    runUpdater();
  }
}

runInInstaller();