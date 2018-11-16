# clever-ripper

Otoroshi addon to shutdown your clever-cloud app instances if not used since an amount of time.

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
SELF_HOST=clever-ripper.foo.bar
SELF_SCHEME=https
TIME_WITHOUT_REQUEST=3600000
RUN_EVERY=60000
```

then run it (this addon is designed to run on clever-cloud)

```sh
yarn start
```