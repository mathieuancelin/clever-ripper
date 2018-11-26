const fetch = require('node-fetch');
const base64 = require('base-64');
const moment = require('moment');
const express = require('express');
const httpProxy = require('http-proxy');
const MongoClient = require('mongodb').MongoClient
const { CleverCloudClient } = require('./clever');
const { TaskQueue } = require('./tasks');
const { Cache } = require('./cache');

const OTOROSHI_URL = process.env.OTOROSHI_URL;
const OTOROSHI_HOST = process.env.OTOROSHI_HOST;
const OTOROSHI_CLIENT_ID = process.env.OTOROSHI_CLIENT_ID;
const OTOROSHI_CLIENT_SECRET = process.env.OTOROSHI_CLIENT_SECRET;
const CLEVER_CONSUMER_KEY = process.env.CLEVER_CONSUMER_KEY; 
const CLEVER_CONSUMER_SECRET = process.env.CLEVER_CONSUMER_SECRET; 
const CLEVER_TOKEN = process.env.CLEVER_TOKEN; 
const CLEVER_SECRET = process.env.CLEVER_SECRET; 
const CLEVER_ORGA = process.env.CLEVER_ORGA;
const SELF_HOST = process.env.SELF_HOST;
const SELF_SCHEME = process.env.SELF_SCHEME;
const DRY_MODE = process.env.DRY_MODE === 'true';
const PROXY_MODE = process.env.PROXY_MODE === 'true';
const CHAT_URL = process.env.CHAT_URL;
const mongoUri = process.env.MONGODB_ADDON_URI;
const mongoDbName = process.env.MONGODB_ADDON_DB;

const ONE_HOUR = 3600 * 1000;
const TIME_WITHOUT_REQUEST = parseInt(process.env.TIME_WITHOUT_REQUEST || (ONE_HOUR + ''), 10);
const RUN_EVERY = parseInt(process.env.RUN_EVERY || (60000 + ''), 10);
const REPORT_EVERY = parseInt(process.env.REPORT_EVERY || (4 * 3600 * 1000 + ''), 10);

function checkIfExist(label, what) {
  if (!what) {
    throw new Error(label + ' does not exist in env. variables');
  }
}

checkIfExist('OTOROSHI_URL', OTOROSHI_URL); 
checkIfExist('OTOROSHI_HOST', OTOROSHI_HOST); 
checkIfExist('OTOROSHI_CLIENT_ID', OTOROSHI_CLIENT_ID); 
checkIfExist('OTOROSHI_CLIENT_SECRET', OTOROSHI_CLIENT_SECRET); 
checkIfExist('CLEVER_CONSUMER_KEY', CLEVER_CONSUMER_KEY); 
checkIfExist('CLEVER_CONSUMER_SECRET', CLEVER_CONSUMER_SECRET); 
checkIfExist('CLEVER_TOKEN', CLEVER_TOKEN); 
checkIfExist('CLEVER_SECRET', CLEVER_SECRET); 
checkIfExist('CLEVER_ORGA', CLEVER_ORGA); 
checkIfExist('SELF_HOST', SELF_HOST); 
checkIfExist('SELF_SCHEME', SELF_SCHEME); 

let mongoStuff = null;

if (mongoUri && mongoDbName) {
  console.log('Connection to Mongo ...')
  MongoClient.connect(mongoUri, (err, client) => {
    if (err) {
      return console.log(err)
    } else {
      const db = client.db(mongoDbName);
      mongoStuff = {
        db,
        collection: db.collection('savings')
      };
    }
  });
}

const proxy = httpProxy.createProxyServer();
const promiseCache = {};
const CleverQueue = new TaskQueue();
const StatusCheckQueue = new TaskQueue();
const appIfForServiceIdCache = new Cache();
const redeployCache = new Cache();
const templateCache = new Cache();
const cleverClient = new CleverCloudClient({
  "consumer_key": CLEVER_CONSUMER_KEY,
  "consumer_secret": CLEVER_CONSUMER_SECRET,
  "oauth_token": CLEVER_TOKEN,
  "oauth_secret": CLEVER_SECRET,
  "organization": CLEVER_ORGA,
});

function sendToChat(message) {
  console.log(message);
  if (CHAT_URL) {
    fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ 
        username: 'clever-ripper',
        text: message,
        payload: JSON.stringify({
          username: 'clever-ripper',
          text: message
        })
      })
    });
  }
}

function fetchOtoroshiServices() {
  return fetch(`${OTOROSHI_URL}/api/services`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    }
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('[fetchOtoroshiServices] Bad status: ' + r.status);
    }
  });
}

function fetchOtoroshiService(id) {
  return fetch(`${OTOROSHI_URL}/api/services/${id}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    }
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('[fetchOtoroshiService] Bad status: ' + r.status);
    }
  });
}

function fetchOtoroshiTemplate(id) {
  return fetch(`${OTOROSHI_URL}/api/services/${id}/template`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    }
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('[fetchOtoroshiTemplate] Bad status: ' + r.status);
    }
  });
}

function fetchRipperEnabledOtoroshiServices() {
  return fetchOtoroshiServices().then(services => {
    return services.filter(service => {
      const lastRestart = parseInt(service.metadata['clever.ripper.restartAtMillis'] || '0', 10);
      // if (service.metadata['clever.ripper.enabled'] === 'true') console.log(lastRestart < (Date.now() - RUN_EVERY), service.metadata);
      return service.metadata 
        && service.metadata['clever.ripper.enabled'] 
        && service.metadata['clever.ripper.enabled'] === 'true'
        && service.metadata['clever.ripper.waiting'] !== 'true'
        && lastRestart < (Date.now() - (RUN_EVERY * 10));
    });
  })
}

function fetchOtoroshiEventsForService(id) {
  const now = Date.now();
  return fetch(`${OTOROSHI_URL}/api/services/${id}/events?from=${now - TIME_WITHOUT_REQUEST}&to=${now}&pageSize=1`, { // Otoroshi v1.2.0+ compatible
  //return fetch(`${OTOROSHI_URL}/api/services/${id}/stats?from=${now - TIME_WITHOUT_REQUEST}&to=${now}`, {           // Otoroshi v1.3.0+ compatible
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    }
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('[fetchOtoroshiEventsForService] Bad status: ' + r.status);
    }
  }).then(arr => {
    return { hits: { count: arr.length } };
  });
}

function fetchAppDeploymentStatus(id) {
  return cleverClient.getApp(id).then(app => {
    return app.state;
  });
}

function shutdownCleverApp(id) {
  console.log('Stopping app ' + id);
  return cleverClient.stopApp(id);
}

function startCleverApp(id) {
  console.log('Starting app ' + id);
  return cleverClient.startApp(id);
}

function routeOtoroshiToRipper(service) {
  console.log('Routing service to the ripper');
  const oldTargets = JSON.stringify(service.targets);
  const oldRoot = service.root;
  const oldRetries = service.clientConfig.retries;
  const oldTimeout = service.clientConfig.callTimeout;
  const oldGlobalTimeout = service.clientConfig.globalTimeout;
  const newMetadata = {
    ...service.metadata,
    'clever.ripper.shutdownAtMillis': Date.now() + '',
    'clever.ripper.shutdownAt': moment().format('DD/MM/YYYY hh:mm:ss'),
    'clever.ripper.targets': oldTargets,
    'clever.ripper.root': oldRoot,
    'clever.ripper.retries': oldRetries + '',
    'clever.ripper.timeout': oldTimeout + '',
    'clever.ripper.gtimeout': oldGlobalTimeout + '',
    'clever.ripper.waiting': 'true',
  };
  Object.keys(newMetadata).map(key => {
    if (key === 'clever.ripper.restartAt' || key === 'clever.ripper.restartAtMillis') {
      delete newMetadata[key];
    }
  });
  return fetch(`${OTOROSHI_URL}/api/services/${service.id}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    },
    body: JSON.stringify({ 
      ...service,
      targets: [
        {
          "host": SELF_HOST,
          "scheme": SELF_SCHEME
        }
      ],
      root: `/waiting-page/${service.id}/`,
      metadata: newMetadata,
      clientConfig: {
        ...service.clientConfig,
        retries: 10,
        callTimeout: 60000,
        globalTimeout: 10 * 60000
      }
    })
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('Bad status: ' + r.status);
    }
  });
}

function routeOtoroshiToClever(service) {
  console.log('Routing service to clever app');
  const oldTargets = JSON.parse(service.metadata['clever.ripper.targets']);
  const oldRoot = service.metadata['clever.ripper.root'];
  const oldRetries = parseInt(service.metadata['clever.ripper.retries'] || '1', 10);
  const oldTimeout = parseInt(service.metadata['clever.ripper.timeout'] || '30000', 10);
  const oldGlobalTimeout = parseInt(service.metadata['clever.ripper.gtimeout'] || '30000', 10);
  const newMetadata = {
    ...service.metadata,
    'clever.ripper.restartAtMillis': Date.now() + '',
    'clever.ripper.restartAt': moment().format('DD/MM/YYYY hh:mm:ss'),
    'clever.ripper.waiting': 'false',
  };
  Object.keys(newMetadata).map(key => {
    if (key === 'clever.ripper.targets' 
        || key === 'clever.ripper.retries'
        || key === 'clever.ripper.timeout'
        || key === 'clever.ripper.gtimeout'
        || key === 'clever.ripper.root' 
        || key === 'clever.ripper.shutdownAt' 
        || key === 'clever.ripper.shutdownAtMillis') {
      delete newMetadata[key];
    }
  });
  CleverQueue.enqueue(() => {
    const appId = service.metadata['clever.ripper.appId'];
    const shutdownAtMillis = parseInt(service.metadata['clever.ripper.shutdownAtMillis'] || (Date.now() + ''), 10);
    if (appId) {
      if (mongoStuff) {
        mongoStuff.collection.findOne(
          { serviceId: service.id, appId: appId }, 
        ).then(doc => {
          if (!doc) {
            mongoStuff.collection.insertOne(
              { serviceId: service.id, appId: appId, name: service.name, saved: 0.0 }, 
            )
          }
        })
        mongoStuff.collection.findOne(
          { serviceId: "global", appId: "global" }
        ).then(doc => {
          if (!doc) {
            mongoStuff.collection.insertOne(
              { serviceId: "global", appId: "global", name: "clever-ripper", saved: 0.0 }, 
            )
          }
        });
      }
      cleverClient.getApp(appId).then(app => {
        const instance = app.instance;
        const minFlavorPrice = instance.minFlavor.price;
        const minInstance = instance.minInstances;
        const savedPerDrop = minInstance * minFlavorPrice;
        let duration = (Date.now() - shutdownAtMillis) / 600000;
        if (duration <= 1.0) {
          duration = 1.0;
        }
        duration = Math.ceil(duration);
        const saved = parseFloat((duration * savedPerDrop * 0.0097).toFixed(5));
        // console.log(`Saved at least ${saved} € for service ${service.name} / ${service.id} / ${appId}`);
        sendToChat(`Saved at least *${saved} €* for service *${service.name}*`);
        if (mongoStuff) {
          mongoStuff.collection.updateOne(
            { serviceId: service.id, appId: appId }, 
            { $inc: { saved: saved } },
          )
          mongoStuff.collection.updateOne(
            { serviceId: "global", appId: "global" }, 
            { $inc: { saved: saved } },
          ).then(() => {
            return displaySavings();
          });
        }
      });
    }
  });
  
  return fetch(`${OTOROSHI_URL}/api/services/${service.id}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Host: OTOROSHI_HOST,
      Authorization: `Basic ${base64.encode(OTOROSHI_CLIENT_ID + ':' + OTOROSHI_CLIENT_SECRET)}`
    },
    body: JSON.stringify({ 
      ...service,
      targets: oldTargets,
      root: oldRoot,
      metadata: newMetadata,
      clientConfig: {
        ...service.clientConfig,
        retries: oldRetries,
        callTimeout: oldTimeout,
        globalTimeout: oldGlobalTimeout
      }
    })
  }).then(r => {
    if (r.status == 200) {
      return r.json();
    } else {
      return Promise.reject('Bad status: ' + r.status);
    }
  });
}

function appIdForService(id) {
  const maybeAppId = appIfForServiceIdCache.get(id);
  if (!maybeAppId) {
    return fetchOtoroshiService(id).then(service => {
      const cleverAppId = service.metadata['clever.ripper.appId'];
      if (cleverAppId) {
        appIfForServiceIdCache.set(id, cleverAppId, 5 * 60000);
        return cleverAppId;
      } else {
        return null;
      }
    });
  } else {
    return Promise.resolve(maybeAppId);
  }
}

function checkServicesToShutDown() {
  //console.log('Checking otoroshi services ...')
  fetchRipperEnabledOtoroshiServices().then(services => {
    // console.log(services.map(s => s.name))
    services.map(service => {
      CleverQueue.enqueue(() => {
        // console.log(`Checking last events for ${service.name}....`);
        fetchOtoroshiEventsForService(service.id).then(stats => {
          // console.log(`Hits for ${service.name} in last ${TIME_WITHOUT_REQUEST} ms: ${JSON.stringify(stats.hits)}`);
          if (stats.hits && stats.hits.count === 0) {
            const cleverAppId = service.metadata['clever.ripper.appId'];
            if (cleverAppId) {
              appIfForServiceIdCache.set(service.id, cleverAppId, 5 * 60000);
              return fetchAppDeploymentStatus(cleverAppId).then(status => {
                if (status === 'SHOULD_BE_UP') {
                  console.log(`Service ${service.name} should be shut down ...`);
                  if (!DRY_MODE) {
                    return routeOtoroshiToRipper(service).then(() => {
                      return shutdownCleverApp(cleverAppId).then(() => {
                        // console.log(`App ${cleverAppId} has been stopped. Next request will start it on the fly`);
                        sendToChat(`App for service *${service.name}* has been stopped. Next http request will start it on the fly`);
                      });
                    });
                  }
                }
              });
            } else {
              console.log(`No clever app id specified for ${service.name}...`);
            }
          }
        });
      });
    });
  });
}

function checkDeploymentStatus(serviceId, cleverAppId) {
  console.log(`checkDeploymentStatus for ${serviceId} - ${cleverAppId}`);
  return fetchAppDeploymentStatus(cleverAppId).then(status => {
    const currentStatus = redeployCache.get(serviceId);
    console.log('current status: ' + currentStatus + '/' + status);
    if (status === 'SHOULD_BE_DOWN' && currentStatus == 'DOWN') {
      return startCleverApp(cleverAppId).then(() => {
        redeployCache.set(serviceId, 'STARTING', 2 * 60000);
        StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
      }).catch(e => {
        redeployCache.set(serviceId, 'DOWN', 2 * 60000);
        StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
      });
    } else if (status === 'WANTS_TO_BE_UP') {
      redeployCache.set(serviceId, 'STARTING', 2 * 60000);
      StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
    } else if (status === 'SHOULD_BE_UP' && currentStatus === 'STARTING') {
      redeployCache.set(serviceId, 'ROUTING', 2 * 60000);
      return fetchOtoroshiService(serviceId).then(service => {
        sendToChat(`App for service *${service.name}* is now up.`);
        if (service.metadata['clever.ripper.waiting'] === 'true') {
          return routeOtoroshiToClever(service).then(() => {
            redeployCache.set(serviceId, 'READY', 2 * 60000);
            StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
          }).catch(e => {
            redeployCache.set(serviceId, 'ROUTING', 2 * 60000);
            StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
          });
        } else {
          redeployCache.set(serviceId, 'READY', 2 * 60000);
          StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
        }
      }).catch(e => {
        redeployCache.set(serviceId, 'ROUTING', 2 * 60000);
        StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
      });
    } else if (status === 'SHOULD_BE_UP' && currentStatus === 'ROUTING') {
      redeployCache.set(serviceId, 'ROUTING', 2 * 60000);
      StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
    } else if (status === 'SHOULD_BE_UP' && currentStatus === 'READY') {
      console.log('Done restarting ' + serviceId);
    }  else if (status === 'SHOULD_BE_UP' && currentStatus === 'DOWN') {
      redeployCache.set(serviceId, 'READY', 2 * 60000);
      console.log('App was already up: ' + serviceId);
    } else {
      redeployCache.set(serviceId, 'DOWN', 2 * 60000);
      StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
    }
  });
}

function requestToStartCleverApp(req, res) {
  const header = req.get('CleverRipper');
  if (header && header === 'status') {
    const serviceId = req.params.serviceId;
    if (serviceId) {
      const currentStatus = redeployCache.get(serviceId); // should be DOWN | STARTING | ROUTING | READY
      if (currentStatus) {
        res.set('CleverRipper', 'true').send({ status: currentStatus });
      } else {
        redeployCache.set(serviceId, 'DOWN', 2 * 60000);
        console.log('Waking up app for service ' + serviceId)
        appIdForService(serviceId).then(cleverAppId => {  
          if (cleverAppId) {
            StatusCheckQueue.enqueue(() => checkDeploymentStatus(serviceId, cleverAppId));
          } else {
            redeployCache.delete(serviceId);
            console.log(`No clever app for service ${serviceId}`);
          }
        });
        res.set('CleverRipper', 'true').send({ status: 'DOWN' });
      }
    }
  } else {
    const serviceId = req.params.serviceId;

    if (!redeployCache.get(serviceId)) { // restart asap !!!
      redeployCache.set(serviceId, 'DOWN', 2 * 60000);
      console.log('Waking up app for service ' + serviceId)
      appIdForService(serviceId).then(cleverAppId => {  
        if (cleverAppId) {
          StatusCheckQueue.enqueue(() => checkDeploymentStatus(serviceId, cleverAppId));
        }
      });
    }

    const accept = req.get('Accept') || 'none';
    if (accept.indexOf('html') < 0) {
      const path = req.path.replace(`/waiting-page/${serviceId}/`, '/');
      let promise = promiseCache[serviceId];
      if (!promise) {
        promise = new Promise((success, failure) => {
          const startedAt = Date.now();
          function checkForCompletion() {
            const currentStatus = redeployCache.get(serviceId);
            if (Date.now() > (startedAt + (10 * 60000))) {
              console.log('Call released but an error occured ...');
              delete promiseCache[serviceId];
              failure('App did not succeded to start');
            } else if (currentStatus === 'READY') {
              console.log('Call released ...')
              delete promiseCache[serviceId];
              setTimeout(() => {
                success('Your app has started, re-run the call ...');
              }, 4000);
            } else {
              setTimeout(() => checkForCompletion(), 2000);
            }
          }
          checkForCompletion();
        });
      }
      return promise.then(() => {
        if (PROXY_MODE) {
          fetchOtoroshiService(serviceId).then(service => {
            const target = service.targets[0];
            proxy.web(req, res, { target: `${target.scheme}://${target.host}`, headers: { 'Host': target.host } });
          });
        } else {
          res.status(307).set('Location', path).send({ redirect: 'Your app has started, re-run the call ...' });
        }
      }, () => {
        res.status(500).send({ error: 'App did not succeded to start' });
      });
    }

    templateCache.getAsync(serviceId, () => {
      return fetchOtoroshiTemplate(serviceId).then(r => {
        const js = `
        <script type="text/javascript">
          function checkState() {
            fetch(window.location.pathname, {
              headers: {
                Accept: 'application/json',
                CleverRipper: 'status',
              }
            }).then(r => {
              if (!r.headers.get('CleverRipper')) {
                window.location.reload();
              } else {
                return r.json();
              }
            }, e => {
              window.location.reload();
            }).then(status => {
              console.log(status.status)
              if (status && status.status === 'READY') {
                window.location.reload();
              }
            }).catch(e => {
              window.location.reload();
            });
          }
          checkState();
          setInterval(checkState, 4000);
        </script>
        `;
        const rawTemplate = r.templateMaintenance;
        let template = rawTemplate;
        if (rawTemplate.indexOf('<body') > -1) {
          const $ = cheerio.load(rawTemplate);
          const body = $('body');
          body.append(js);
          template = $.html();
        } else {
          template = rawTemplate + js;
        }
        template =  template
          .replace("${message}", 'Your app is starting, please wait ...')
          .replace("${cause}", 'You will be redirected automatically when it\'s ready')
          .replace("${otoroshiMessage}", 'Your app is starting, please wait ...')
          .replace("${errorId}", '')
          .replace("${status}", '');
        templateCache.set(serviceId, template, 10 * 60000);
        return template;
      }, e => `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <title>Clever Ripper</title>
            <meta name="robots" content="noindex, nofollow">
            <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.1.3/css/bootstrap.min.css" integrity="sha384-MCw98/SFnGE8fJT3GXwEOngsV7Zt27NXFoaoApmYm81iuXoPkFOJwJ8ERdknLPMO" crossorigin="anonymous">
          </head>
          <body style="background-color: rgb(55,55,55); color: white; width: 100vw; height: 100vh; margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; flex-direction: column;">
            <img style="width: 240px; margin-bottom: 40px;" src="https://www.otoroshi.io/assets/images/logos/otoroshi.png">
            <h3>Your app is starting, please wait ...</h3>
            <h5>You will be redirected automatically when it's ready</h5>
            <script type="text/javascript">
              function checkState() {
                fetch(window.location.pathname, {
                  headers: {
                    Accept: 'application/json',
                    CleverRipper: 'status',
                  }
                }).then(r => {
                  if (!r.headers.get('CleverRipper')) {
                    window.location.reload();
                  } else {
                    return r.json();
                  }
                }, e => {
                  window.location.reload();
                }).then(status => {
                  console.log(status.status)
                  if (status && status.status === 'READY') {
                    window.location.reload();
                  }
                }).catch(e => {
                  window.location.reload();
                });
              }
              checkState();
              setInterval(checkState, 4000);
            </script>
          </body>
        </html>
        `);
    }).then(template => {
      res.type('html').send(template);
    });
  }
}

function computeSavings() {
  return fetchOtoroshiServices().then(services => {
    return Promise.all(services.filter(service => {
      return service.metadata['clever.ripper.enabled'] === 'true' && service.metadata['clever.ripper.waiting'] === 'true'
    }).map(service => {
      const appId = service.metadata['clever.ripper.appId'];
      const shutdownAtMillis = parseInt(service.metadata['clever.ripper.shutdownAtMillis'] || (Date.now() + ''), 10);
      return cleverClient.getApp(appId).then(app => {
        const instance = app.instance;
        const minFlavorPrice = instance.minFlavor.price;
        const minInstance = instance.minInstances;
        const savedPerDrop = minInstance * minFlavorPrice;
        let duration = (Date.now() - shutdownAtMillis) / 600000;
        if (duration <= 1.0) {
          duration = 1.0;
        }
        duration = Math.ceil(duration);
        const saved = parseFloat((duration * savedPerDrop * 0.0097).toFixed(5));
        return { name: service.name, serviceId: service.id, appId, saved };
      });
    })).then(savings => {
      const currentSaved = savings.reduce((a, b) => {
        return a + b.saved;
      }, 0.0);
      if (mongoStuff) {
        return mongoStuff.collection.find({}).toArray().then(arr => {
          const pastSaved = arr.filter(a => a.serviceId !== 'global').reduce((a, b) => a + b.saved, 0.0)
          return {
            total: {
              current: currentSaved,
              past: pastSaved,
              total: pastSaved + currentSaved,
            },
            currentSavings: savings,
            pastSavings: arr.map(a => {
              delete a._id;
              return a;
            })
          };
        });
      } else {
        return {
          total: {
            current: currentSaved,
            past: 0.0,
            total: 0.0 + currentSaved,
          },
          currentSavings: savings
        };
      }
    }); 
  });
}

function displaySavings() {
  computeSavings().then(savings => {
    // console.log(`Current savings are: ${JSON.stringify(savings.total)}`)
    sendToChat(`Current savings are: *${savings.total.total.toFixed(5)} €*`);
  });
}

function computeCandidates() {
  return fetchOtoroshiServices().then(services => {
    const candidates = services.filter(s => s.enabled && s.metadata['clever.ripper.enabled'] !== 'true');
    return new Promise((success, failure) => {
      const results = [];
      function processNext() {
        const service = candidates.pop();
        if (service) {
          fetchOtoroshiEventsForService(service.id).then(count => {
            const hits = (count.hits || { count: 0 }).count || 0;
            if (hits === 0) {
              results.push({ count: hits || 0, name: service.name });
            }
            setTimeout(() => processNext(), 300);
          }, e => {
            setTimeout(() => processNext(), 300);
          });
        } else {
          success(results);
        }
      }
      processNext();
    });
  });
}

function displayCandidates() {
  computeCandidates().then(candidates => {
    if (candidates.length > 0) {
      const candidatesStr = candidates.map(c => {
        return ` * ${c.name}`;
      }).join('\n');
      sendToChat(`Good candidates (${candidates.length}) for clever-ripper are : \n\n${candidatesStr}`);
    }
  });
}

if (process.env.ONE_SHOT === 'true') {
  displayCandidates();
  //checkServicesToShutDown();
} else {
  const app = express()
  const port = process.env.PORT || 8080;
  const stateHeader = process.env.STATE_HEADER || 'Otoroshi-State';
  const stateRespHeader = process.env.STATE_RESP_HEADER || 'Otoroshi-State-Resp';
  function otoroshiMiddleware(req, res, next) {
    res.set(stateRespHeader, req.get(stateHeader) || 'none');
    next();
  }
  app.use(otoroshiMiddleware);
  app.all('/waiting-page/:serviceId/', requestToStartCleverApp);
  app.all('/waiting-page/:serviceId/*', requestToStartCleverApp);
  app.get('/api/savings', (req, res) => computeSavings().then(savings => res.send(savings)));
  app.get('/api/health', (req, res) => {
    res.status(200).send({ healthy: true, message: "Yes, I'm healthy !!!" });
  });
  app.use((err, req, res, next) => {
    if (err) {
      res.set(stateRespHeader, req.get(stateHeader) || 'none');
      res.status(500).send({ error: err.message })
    } else {
      try {
        next();
      } catch(e) {
        res.set(stateRespHeader, req.get(stateHeader) || 'none');
        res.status(500).send({ error: e.message })
      }
    }
  });
  app.listen(port, () => {
    console.log(`clever-ripper listening on port ${port}!`);
    const instanceType = process.env.INSTANCE_TYPE || 'none';
    if (instanceType === 'build') {
      console.log('On clever build instance, doing nothing !!!');
    } else {
      checkServicesToShutDown();
      setTimeout(() => {
        setInterval(checkServicesToShutDown, RUN_EVERY);
      }, 10000);
      setTimeout(() => displaySavings(), 20000);
      setInterval(() => {
        displaySavings();
      }, REPORT_EVERY);
      setTimeout(() => displayCandidates(), 20000);
      setInterval(() => {
        displayCandidates();
      }, TIME_WITHOUT_REQUEST * 4)
    }
  });
}

