const fetch = require('node-fetch');
const base64 = require('base-64');
const moment = require('moment');
const express = require('express');
const { CleverCloudClient } = require('./clever');

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

const ONE_HOUR = 3600 * 1000;
const MINUS = parseInt(process.env.MINUS || (ONE_HOUR + ''), 10);
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
      if (service.metadata['clever.ripper.enabled'] === 'true') console.log(lastRestart, (Date.now() - RUN_EVERY), service.metadata);
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
  return fetch(`${OTOROSHI_URL}/api/services/${id}/events?from=${now - MINUS}&to=${now}`, {
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

function checkServicesToShutDown() {
  console.log('Checking otoroshi services ...')
  fetchRipperEnabledOtoroshiServices().then(services => {
    services.map(service => {
      fetchOtoroshiEventsForService(service.id).then(events => {
        if (events.length === 0) {
          const cleverAppId = service.metadata['clever.ripper.appId'];
          if (cleverAppId) {
            fetchAppDeploymentStatus(cleverAppId).then(status => {
              if (status === 'SHOULD_BE_UP') {
                console.log(`Service ${service.name} should be shut down ...`);
                routeOtoroshiToRipper(service).then(() => {
                  shutdownCleverApp(cleverAppId).then(() => {
                    console.log(`App ${cleverAppId} has been stopped. Next request will start it on the fly`);
                  });
                });
              }
            });
          } else {
            console.log(`No clever app id specified for ${service.name}...`);
          }
        }
      })
    });
  });
}

function requestToStartCleverApp(req, res) {
  const serviceId = req.params.serviceId;
  if (serviceId) {
    fetchOtoroshiService(serviceId).then(service => {
      const cleverAppId = service.metadata['clever.ripper.appId'];
      if (cleverAppId) {
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
                fetch('${SELF_SCHEME}://${SELF_HOST}/status/${serviceId}/${cleverAppId}').then(r => r.json()).then(status => {
                  if (status.status === 'READY') {
                    window.location.reload();
                  }
                  if (status.status === 'SHOULD_BE_UP') {
                    window.location.reload();
                  }
                });
              }
              setInterval(checkState, 10000);
            </script>
          </body>
        </html>
        `;
        fetchAppDeploymentStatus(cleverAppId).then(status => {
          if (status === 'SHOULD_BE_DOWN') {
            startCleverApp(cleverAppId).then(() => {
              res.type('html').send(body);
            }).catch(e => {
              res.status(500).send({ error: e.message });
            });
          } else {
            res.type('html').send(body);
          }
        });
      } else {
        res.status(500).send({ error: 'No clever app ???' });
      }
    });
  } else {
    res.status(500).send({ error: 'No service ????' });
  }
}

function requestCleverAppStatus(req, res) {
  const cleverAppId = req.params.cleverAppId;
  const serviceId = req.params.serviceId;
  if (cleverAppId && serviceId) {
    fetchAppDeploymentStatus(cleverAppId).then(status => {
      if (status === 'SHOULD_BE_UP') {
        fetchOtoroshiService(serviceId).then(service => {
          if (service.metadata['clever.ripper.waiting'] === 'true') {
            routeOtoroshiToClever(service).then(() => {
              res.send({ status: 'READY' });
            })
          } else {
            res.send({ status });
          }
        }).catch(e => {
          res.status(500).send({ error: e.message });
        });
      } else {
        res.send({ status });
      }
    }).catch(e => {
      res.status(500).send({ error: e.message });
    });
  } else {
    res.status(500).send({ error: 'No service or app ????' });
  }
}

if (process.env.ONE_SHOT === 'true') {
  checkServicesToShutDown();
} else {
  const app = express()
  const port = process.env.PORT || 8080;
  app.all('/waiting-page/:serviceId/', requestToStartCleverApp);
  app.all('/waiting-page/:serviceId/*', requestToStartCleverApp);
  app.get('/status/:serviceId/:cleverAppId', requestCleverAppStatus);
  app.listen(port, () => {
    console.log(`Clever ripper listening on port ${port}!`);
    checkServicesToShutDown();
    setInterval(checkServicesToShutDown, RUN_EVERY);
  });
}

