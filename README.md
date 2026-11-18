# Dino-Kart

## Android / Fire tablet app

The game is wrapped as an Android app with [Capacitor](https://capacitorjs.com): the `android/` project is a thin
shell that shows the built web files full screen, offline, locked to landscape. Package ID
`com.scott1up.dinokart`, Fire OS 7 or newer.

```sh
npm run android:apk    # builds the web app, copies it into android/, and produces a release APK
```

The APK lands in `android/app/build/outputs/apk/release/app-release.apk`. Building needs JDK 21 and the Android SDK
(`brew install openjdk@21` and `brew install --cask android-commandlinetools`, then
`sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`), with the SDK path in
`android/local.properties` as `sdk.dir=...`.

Release builds are signed with the key named in `android/keystore.properties` (git-ignored, as is the `.jks` file
itself). Keep a backup of both: updates must be signed with the same key. Bump `versionCode` in
`android/app/build.gradle` for every new build you install over an old one.

The launcher icons are made by `npm run icons`.
