To scaffold a new handler
```shell
npx tgcloud add handlers/<type>
```

As you work, a handful of commands keep your local project and the cloud aligned: npx tgcloud status shows what changed,
npx tgcloud push deploys, npx tgcloud pull brings your local project in line with the cloud, npx tgcloud fetch refreshes
the reference copy without touching your files, and npx tgcloud reset discards local changes.