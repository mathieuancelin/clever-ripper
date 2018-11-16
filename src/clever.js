
const ccurl = 'https://api.clever-cloud.com/v2';
const axios = require('axios');
const moment = require('moment');
const CleverAPI = require('clever-client');

class CleverCloudClient {

  constructor(config) {
    console.log('CleverCloud init client');
    const client = CleverAPI({
      API_HOST: ccurl,
      API_CONSUMER_KEY: config.consumer_key,
      API_CONSUMER_SECRET: config.consumer_secret,
      API_OAUTH_TOKEN: config.oauth_token,
      API_OAUTH_TOKEN_SECRET: config.oauth_secret,
    });
    client.session.getAuthorization = (httpMethod, url, params) => {
      return this.client.session.getHMACAuthorization(httpMethod, url, params, {
        user_oauth_token: config.oauth_token,
        user_oauth_token_secret: config.oauth_secret
      });
    };

    this.client = client;
    this.organization = config.organization;

    this.call = (httpMethod, target, headers = {}, body = {}, params) => {
      const url = `${ccurl}${target}`;

      const options = {url, method: httpMethod, headers: headers || {}, params};
      if (body) options.data = body;

      options.headers = {
        "content-type": "application/json",
        "Authorization": this.client.session.getHMACAuthorization(httpMethod, url, {}, {
          user_oauth_token: config.oauth_token,
          user_oauth_token_secret: config.oauth_secret
        })
      };

      return axios(options)
        .then(response => response.data)
        .catch(error => {
          console.log("error ", error);
          if (error.response)
            throw {
              code: error.response.status,
              message: error.response.statusText,
              reason: JSON.stringify(error.response.data)
            };
          else
            throw {code: 500, reason: error};
        });
    }
  }

  getInstanceTypes() {
    return this.client.products.instances.get().send().toPromise();
  }

  getAddonProviders() {
    return this.client.products.addonproviders.get().send().toPromise();
  }

  createApp(name, instanceType, region, tags, github) {
    let body = {
      'deploy': 'git',
      'description': name,
      'instanceType': instanceType.type,
      'instanceVersion': instanceType.version,
      'instanceVariant': instanceType.variant.id,
      'maxFlavor': 'S',
      'maxInstances': 1,
      'minFlavor': 'S',
      'minInstances': 1,
      'name': name,
      'zone': region,
      'tags': tags,
      'cancelOnPush': true,
      'separateBuild': true,
    };

    if (github) {
      body.githubApp = {
        'id': github.owner.id,
        'owner': github.owner.login,
        'name': github.name,
        'description': github.description,
        'gitUrl': `${github.url}.git`,
        'priv': false
      };
      body.oauthService = 'github';
      body.oauthAppId = `${github.id}`;
      body.branch = github.branch ? github.branch : github.default_branch;
    }
    console.log('CleverCloud.createApp', JSON.stringify(body));
    return this.client.owner(this.organization).applications.post().withParams([this.organization]).send(JSON.stringify(body)).toPromise();
  }

  getScalability(appId) {
    return this.client.owner(this.organization).applications._.get().withParams([this.organization, appId]).send().toPromise()
      .then(app => {
        return {
          appId,
          minInstances: app.instance.minInstances,
          maxInstances: app.instance.maxInstances,
          minFlavor: app.instance.minFlavor.name,
          maxFlavor: app.instance.maxFlavor.name,
          flavors: app.instance.flavors
        }
      });
  }

  updateScalability(appId, options) {
    return this.client.owner(this.organization).applications._.get().withParams([this.organization, appId]).send().toPromise()
      .then(app => {
        let body = {
          "id": appId,
          "type": app.instance.type,
          "version": app.instance.version,
          "variant": app.instance.variant,
          "minInstances": options.minInstances,
          "maxInstances": options.maxInstances,
          "maxAllowedInstances": app.instance.maxAllowedInstances,
          "minFlavor": options.minFlavor,
          "maxFlavor": options.maxFlavor,
          "defaultEnv": app.instance.defaultEnv,
          "instanceAndVersion": app.instance.instanceAndVersion
        };

        return this.client.owner(this.organization).applications._.put().withParams([this.organization, appId]).send(JSON.stringify(body)).toPromise()
          .then(data => {
            return {
              appId,
              minInstances: data.instance.minInstances,
              maxInstances: data.instance.maxInstances,
              minFlavor: data.instance.minFlavor.name,
              maxFlavor: data.instance.maxFlavor.name,
              flavors: data.instance.flavors
            }
          })
      });
  }

  getAppEnv(appId) {
    return this.client.owner(this.organization).applications._.env.get().withParams([this.organization, appId]).send().toPromise();
  }

  addEnv(appId, envName, envValue) {
    return this.client.owner(this.organization).applications._.env._.put().withParams([this.organization, appId, envName]).send(JSON.stringify({
      name: envName,
      value: envValue
    })).toPromise();
  }

  putEnv(appId, env) {
    return this.client.owner(this.organization).applications._.env.put().withParams([this.organization, appId]).send(JSON.stringify(env)).toPromise();
  }

  deleteEnv(appId, envName) {
    return this.client.owner(this.organization).applications._.env._.delete().withParams([this.organization, appId, envName]).send().toPromise();
  }

  putAppBranch(appId, branch) {
    return this.client.owner(this.organization).applications._.branch.put().withParams([this.organization, appId]).send(JSON.stringify(branch)).toPromise();
  }

  linkApp(appId, depId) {
    return this.client.owner(this.organization).applications._.dependencies._.put().withParams([this.organization, appId, depId]).send().toPromise();
  }

  unlinkApp(appId, depId) {
    return this.client.owner(this.organization).applications._.dependencies._.delete().withParams([this.organization, appId, depId]).send().toPromise();
  }

  getLinkApp(appId) {
    return this.client.owner(this.organization).applications._.dependencies.get().withParams([this.organization, appId]).send().toPromise();
  }

  getLinkAddons(appId) {
    return this.client.owner(this.organization).addons.get().withParams([this.organization]).send().toPromise()
      .then(addons => {

        if (appId)
          return this.client.owner(this.organization).applications._.addons.get().withParams([this.organization, appId]).send().toPromise()
            .then(addonsLinked => {
              return addons.map(addon => {
                return {
                  ...addon,
                  linked: addonsLinked.findIndex(link => link.id === addon.id) !== -1
                };
              })
            });
        else
          return addons;
      });
  }

  preorderAddon(name, planId, providerId, region) {
    return this.client.owner(this.organization).addons.preorders.post().withParams([this.organization]).send(JSON.stringify({
      name: name,
      plan: planId,
      providerId: providerId,
      region: region
    })).toPromise();
  }

  createAddon(name, planId, providerId, region) {
    return this.client.owner(this.organization).addons.post().withParams([this.organization]).send(JSON.stringify({
      name: name,
      plan: planId,
      providerId: providerId,
      region: region
    })).toPromise();
  }

  linkAddon(appId, addonId) {
    return this.client.owner(this.organization).applications._.addons.post().withParams([this.organization, appId]).send(JSON.stringify(addonId)).toPromise();
  }

  unlinkAddon(appId, addonId) {
    return this.client.owner(this.organization).applications._.addons._.delete().withParams([this.organization, appId, addonId]).send().toPromise();
  }

  getAppAddons(appId) {
    return this.client.owner(this.organization).applications._.addons.get().withParams([this.organization, appId]).send().toPromise();
  }

  getAddonApplications(addonId) {
    return this.client.owner(this.organization).addons._.applications.get().withParams([this.organization, addonId]).send().toPromise();
  }

  getAddonTags(addonId) {
    return this.client.owner(this.organization).addons._.tags.get().withParams([this.organization, addonId]).send().toPromise();
  }

  getAddonEnv(addonId) {
    return this.client.owner(this.organization).addons._.env.get().withParams([this.organization, addonId]).send().toPromise();
  }

  deleteAddon(addonId) {
    return this.client.owner(this.organization).addons._.delete().withParams([this.organization, addonId]).send().toPromise();
  }

  putAddonTag(addonId, tag) {
    return this.client.owner(this.organization).addons._.tags._.put().withParams([this.organization, addonId, tag]).send(JSON.stringify(tag)).toPromise();
  }

  getApp(appId) {
    if (!appId) {
      return this.client.owner(this.organization).applications.get().withParams([this.organization]).send().toPromise();
    } else {
      return this.client.owner(this.organization).applications._.get().withParams([this.organization, appId]).send().toPromise();
    }
  }

  getAppTags(appId) {
    return this.client.owner(this.organization).applications._.tags.get().withParams([this.organization, appId]).send().toPromise();
  }

  putTag(appId, tag) {
    console.log('putTag', appId, tag);
    return this.client.owner(this.organization).applications._.tags._.put().withParams([this.organization, appId, tag]).send(JSON.stringify(tag)).toPromise();
  }

  deleteTag(appId, tag) {
    console.log('deleteTag', appId, tag);
    return this.client.owner(this.organization).applications._.tags._.delete().withParams([this.organization, appId, tag]).send().toPromise();
  }

  getAddons(addonId) {
    if (!addonId)
      return this.client.owner(this.organization).addons.get().withParams([this.organization]).send().toPromise();
    else
      return this.client.owner(this.organization).addons._.get().withParams([this.organization, addonId]).send().toPromise();
  }

  deleteApp(appId) {
    return this.client.owner(this.organization).applications._.delete().withParams([this.organization, appId]).send().toPromise();
  }

  logs(appId, from, to, filter, limit = 50, order = 'desc') {
    const params = {
      order,
      after: from || moment().subtract(1, 'days').toISOString(),
      before: to || moment().toISOString(),
      limit,
    };

    if (filter) {
      console.log("==============> add filter to search " + filter);
      params.filter = filter;
    }

    console.log('search with', params)

    return this.call('GET', `/logs/${appId}`, {}, {}, params);
  }

  deployments(appId) {
    return this.client.owner(this.organization).applications._.deployments.get().withParams([this.organization, appId]).withQuery({limit: "10"}).send().toPromise();
  }

  forceBuildAndRestart(appId) {
    return this.client.owner(this.organization).applications._.instances.post().withParams([this.organization, appId]).withQuery({useCache: "no"}).send().toPromise();
  };

  buildWithLastCommit(appId) {
    return this.client.owner(this.organization).applications._.instances.post().withParams([this.organization, appId]).withQuery({commit: "HEAD"}).send().toPromise();
  };

  startApp(appId, commitId) {
    if (commitId)
      return this.client.owner(this.organization).applications._.instances.post().withParams([this.organization, appId]).withQuery({commit: commitId}).send().toPromise();
    else
      return this.client.owner(this.organization).applications._.instances.post().withParams([this.organization, appId]).send().toPromise();
  }

  stopApp(appId) {
    return this.client.owner(this.organization).applications._.instances.delete().withParams([this.organization, appId]).send().toPromise();
  }

  appIsStarted(appId) {
    return this.client.owner(this.organization).applications._.instances.get().withParams([this.organization, appId]).send().toPromise();
  }

  getExposedEnv(appId) {
    return this.client.owner(this.organization).applications._.exposed_env.get().withParams([this.organization, appId]).send().toPromise();
  }

  updateExposedEnv(appId, exposedEnv) {
    return this.client.owner(this.organization).applications._.exposed_env.put().withParams([this.organization, appId]).send(JSON.stringify(exposedEnv)).toPromise();
  }
}

exports.CleverCloudClient = CleverCloudClient;