/* Keeps a copy of the till on the iPad so it opens with no internet.
   Change CACHE when you send a new version of the files. */

var CACHE = 'till-38';

var NAV_WAIT_MS = 4000;

/* The request, or a failure if the answer takes longer than `ms`. */
function fetchWithin(request, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('Too slow')); }, ms);
    fetch(request).then(function (response) {
      clearTimeout(timer);
      resolve(response);
    }, function (err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function savedPage() {
  return caches.match('./index.html');
}

var FILES = [
  './',
  './index.html',
  './db.js',
  './cart.js',
  './receipt.js',
  './report.js',
  './backup.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE) { return caches.delete(name); }
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') { return; }

  // Opening the app: try the internet for at most NAV_WAIT_MS, then use the
  // saved page. WiFi that is connected but has no internet can make a
  // request hang for a minute or more; the till must still open at once.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithin(request, NAV_WAIT_MS).then(function (response) {
        if (response && response.ok) { return response; }
        return savedPage().then(function (hit) { return hit || response; });
      }).catch(function () {
        return savedPage().then(function (hit) { return hit || fetch(request); });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) { return hit; }
      return fetch(request).then(function (response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
