
const ccurl = 'https://api.clever-cloud.com/v2';
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
  }

  getAppEnv(appId) {
    return this.client.owner(this.organization).applications._.env.get().withParams([this.organization, appId]).send().toPromise();
  }

  getApp(appId) {
    if (!appId) {
      return this.client.owner(this.organization).applications.get().withParams([this.organization]).send().toPromise();
    } else {
      return this.client.owner(this.organization).applications._.get().withParams([this.organization, appId]).send().toPromise();
    }
  }

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
}

exports.CleverCloudClient = CleverCloudClient;