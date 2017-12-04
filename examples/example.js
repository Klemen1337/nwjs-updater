var updater = require('../nwjs-updater');
let package = require('../package.json');

var url = "https://pos.dev.olaii.com/api/v1/registers/misc/package.json";
var headers = {
  "Authorization": 'Bearer BhU5fgWJJo1yUjGlmkIPMKDlEtaiIg',
  "X-PosId": "krneki",
  "Content-Type": "application/json"
};

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
  console.error(error);
})



function runInInstaller(){
  if(gui.App.argv.length) {
    // ------------- 6 -------------
    copyPath = gui.App.argv[0];
    execPath = gui.App.argv[1];

    // Replace old app, Run updated app from original location and close temp instance
    updater.install(copyPath, function(err) {
        if(!err) {

            // ------------- 7 -------------
            updater.run(execPath, null);
            gui.App.quit();
        }
    });
  }
}
