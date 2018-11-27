# clever-ripper

Otoroshi addon to shutdown your clever-cloud app instances if not used since a specific amount of time.

## Run

first you have to define some env. variables

```sh
OTOROSHI_URL=https://otoroshi-api.foo.bar
OTOROSHI_HOST=otoroshi-api.foo.bar
OTOROSHI_CLIENT_ID=xxx
OTOROSHI_CLIENT_SECRET=xxxxxx
CLEVER_CONSUMER_KEY=xxxxxx
CLEVER_CONSUMER_SECRET=xxxxx
CLEVER_TOKEN=xxxxxx
CLEVER_SECRET=xxxxxx
CLEVER_ORGA=orga_xxxxx
SELF_HOST=appid.cleverapps.io
SELF_SCHEME=https
TIME_WITHOUT_REQUEST=3600000
RUN_EVERY=60000
```

then run it (this addon is designed to run on clever-cloud)

```sh
yarn start
```

## Enable support in Otoroshi 

You have to add two properties in each service metadata to enable `clever-ripper` on it

```
clever.ripper.enabled: true
clever.ripper.appId: xxxxx.cleverapps.io
```

**WARNING** `clever-ripper` will only check if the app had http traffic during the last `$TIME_WITHOUT_REQUEST` milliseconds. If your application has some cron jobs, scheduled job, etc that doesn't use http throught Otoroshi, it will be shut down by `clever-ripper`

Once an application has been shut down, the first http request will restart the application. A waiting page will be displayed (based on your custom maintainance template if it exists) until the app is back online.
