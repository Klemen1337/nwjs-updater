var updater = require('../nwjs-updater');
var package = require('../package.json');

var url = "";
var headers = {};

// ------------------ 1 ------------------
updater.checkVersion(url, headers).then(function(newManifest){
  // console.log(package);

  // ------------------ 2 ------------------
  if(updater.isThereNewVersion(package.version, newManifest.version)){

    // ------------------ 3 ------------------
    updater.download(newManifest, function(downloadStatus){
      // Download status
    }).then(function(downloadResponse){
      // ------------------ 4 ------------------
      updater.unpack(downloadResponse, newManifest).then(function(unpackResponse){
    
        // ------------------ 5 ------------------
        updater.runInstaller(newManifest);
      }, function(error){
        console.error(error);
      });
    }, function(error){
      console.error(error);
    });
  } else {
    console.error("No new update!");
  }
}, function(error){
  console.error("Cannot fetch new manifest:", error);
});



function runInInstaller(){
  if(gui.App.argv.length) {
    // ------------- 6 -------------
    copyPath = gui.App.argv[0];
    execPath = gui.App.argv[1];

    // Replace old app, Run updated app from original location and close temp instance
    updater.install(copyPath).then(function() {
      // ------------- 7 -------------
      updater.run(execPath, null);
      gui.App.quit();
    });
  }
}