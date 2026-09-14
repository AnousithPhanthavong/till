// Foundation build. This file only runs the three installation checks.

var VERSION = 1;

function setCheck(id, passed, text) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('pass', passed);
  el.querySelector('.state').textContent = text;
}

function runningFromHomeScreen() {
  return window.navigator.standalone === true ||
         window.matchMedia('(display-mode: standalone)').matches;
}

function updateHomeScreenCheck() {
  if (runningFromHomeScreen()) {
    setCheck('check-home', true, 'Yes. This is the installed app.');
  } else {
    setCheck('check-home', false, 'No. This is still Safari. Use Share, then Add to Home Screen.');
  }
}

function updateNetworkCheck() {
  if (navigator.onLine) {
    setCheck('check-net', false, 'Connected. Turn on airplane mode to run the test.');
  } else {
    setCheck('check-net', false, 'Off. The app is running with no internet.');
  }
}

function updateOfflineCopyCheck() {
  if (!('serviceWorker' in navigator)) {
    setCheck('check-copy', false, 'Not supported on this device.');
    return;
  }
  if (navigator.serviceWorker.controller) {
    setCheck('check-copy', true, 'Saved. The app opens without internet.');
  } else {
    setCheck('check-copy', false, 'Saving… close and reopen the app once.');
  }
}

document.getElementById('version').textContent = VERSION;
updateHomeScreenCheck();
updateNetworkCheck();
updateOfflineCopyCheck();

window.addEventListener('online', updateNetworkCheck);
window.addEventListener('offline', updateNetworkCheck);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').then(function () {
    return navigator.serviceWorker.ready;
  }).then(function () {
    updateOfflineCopyCheck();
  }).catch(function () {
    setCheck('check-copy', false, 'Could not save. Check the address starts with https.');
  });

  navigator.serviceWorker.addEventListener('controllerchange', updateOfflineCopyCheck);
}
