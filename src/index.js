const fetch = require('node-fetch');
const base64 = require('base-64');
const moment = require('moment');
const express = require('express');
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

const ONE_HOUR = 3600 * 1000;
const TIME_WITHOUT_REQUEST = parseInt(process.env.MINUS || (ONE_HOUR + ''), 10);
const RUN_EVERY = parseInt(process.env.RUN_EVERY || (60000 + ''), 10);

function checkIfExist(label, what) {
  if (!what) {
    throw new Error(label + ' is not defined');
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

const CleverQueue = new TaskQueue();
const StatusCheckQueue = new TaskQueue();
const appIfForServiceIdCache = new Cache();
const redeployCache = new Cache();
const cleverClient = new CleverCloudClient({
  "consumer_key": CLEVER_CONSUMER_KEY,
  "consumer_secret": CLEVER_CONSUMER_SECRET,
  "oauth_token": CLEVER_TOKEN,
  "oauth_secret": CLEVER_SECRET,
  "organization": CLEVER_ORGA,
});

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
      return Promise.reject('Bad status: ' + r.status);
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
      return Promise.reject('Bad status: ' + r.status);
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
        && lastRestart < (Date.now() - RUN_EVERY);
    });
  })
}

function fetchOtoroshiEventsForService(id) {
  const now = Date.now();
  return fetch(`${OTOROSHI_URL}/api/services/${id}/stats?from=${now - TIME_WITHOUT_REQUEST}&to=${now}`, {
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
      return Promise.reject('Bad status: ' + r.status);
    }
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
  const newMetadata = {
    ...service.metadata,
    'clever.ripper.shutdownAtMillis': Date.now() + '',
    'clever.ripper.shutdownAt': moment().format('DD/MM/YYYY hh:mm:ss'),
    'clever.ripper.targets': oldTargets,
    'clever.ripper.root': oldRoot,
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
      metadata: newMetadata
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
  const newMetadata = {
    ...service.metadata,
    'clever.ripper.restartAtMillis': Date.now() + '',
    'clever.ripper.restartAt': moment().format('DD/MM/YYYY hh:mm:ss'),
    'clever.ripper.waiting': 'false',
  };
  Object.keys(newMetadata).map(key => {
    if (key === 'clever.ripper.targets' || key === 'clever.ripper.root' || key === 'clever.ripper.shutdownAt' || key === 'clever.ripper.shutdownAtMillis') {
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
      targets: oldTargets,
      root: oldRoot,
      metadata: newMetadata
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
  console.log('Checking otoroshi services ...')
  fetchRipperEnabledOtoroshiServices().then(services => {
    // console.log(services.map(s => s.name))
    services.map(service => {
      CleverQueue.enqueue(() => {
        console.log(`Checking last events for ${service.name}....`);
        fetchOtoroshiEventsForService(service.id).then(stats => {
          console.log(`Hits for ${service.name} in last ${TIME_WITHOUT_REQUEST} ms: ${JSON.stringify(stats.hits)}`);
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
                        console.log(`App ${cleverAppId} has been stopped. Next request will start it on the fly`);
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
        if (service.metadata['clever.ripper.waiting'] === 'true') {
          return routeOtoroshiToClever(service).then(() => {
            redeployCache.set(serviceId, 'READY', 2 * 60000);
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
    } else {
      redeployCache.set(serviceId, 'DOWN', 2 * 60000);
      StatusCheckQueue.enqueueIn(2000)(() => checkDeploymentStatus(serviceId, cleverAppId));
    }
  });
}

function requestToStartCleverApp(req, res) {
  const header = req.get('CleverRipper');
  if (header && header === 'status') {
    const body = `
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
            }).then(r => r.json()).then(status => {
              console.log(status.status)
              if (status.status === 'READY') {
                window.location.reload();
              }
            });
          }
          setInterval(checkState, 10000);
        </script>
      </body>
    </html>
    `;
    res.type('html').send(body);
  } else {
    const serviceId = req.params.serviceId;
    if (serviceId) {
      const currentStatus = redeployCache.get(serviceId); // should be DOWN | STARTING | ROUTING | READY
      if (currentStatus) {
        res.send({ status: currentStatus });
      } else {
        console.log('Waking up app for service ' + serviceId)
        redeployCache.set(serviceId, 'DOWN', 2 * 60000);
        appIdForService(serviceId).then(cleverAppId => {  
          if (cleverAppId) {
            StatusCheckQueue.executeNext(() => checkDeploymentStatus(serviceId, cleverAppId));
          } else {
            redeployCache.delete(serviceId);
            console.log(`No clever app for service ${serviceId}`);
          }
        });
      }
    }
  }
}

if (process.env.ONE_SHOT === 'true') {
  checkServicesToShutDown();
} else {
  const app = express()
  const port = process.env.PORT || 8080;
  const stateHeader = process.env.STATE_HEADER = 'Otoroshi-State';
  const stateRespHeader = process.env.STATE_RESP_HEADER = 'Otoroshi-State-Resp';
  function otoroshiMiddleware(req, res, next) {
    res.set(stateRespHeader, req.get(stateHeader) || 'none');
    next();
  }
  app.use(otoroshiMiddleware);
  app.all('/waiting-page/:serviceId/', requestToStartCleverApp);
  app.all('/waiting-page/:serviceId/*', requestToStartCleverApp);
  app.listen(port, () => {
    console.log(`clever-ripper listening on port ${port}!`);
    checkServicesToShutDown();
    setTimeout(() => {
      setInterval(checkServicesToShutDown, RUN_EVERY);
    }, 10000);
  });
}

