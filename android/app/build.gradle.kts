plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.feroz.flexviewer"
    compileSdk = 34

    defaultConfig {
        // One app for every map (FLEX Field). Maps are zips opened inside it,
        // not baked into the APK, so there is no per-cave identity any more.
        applicationId = "com.feroz.flexfield"
        minSdk        = 26
        targetSdk     = 34
        versionCode   = 2
        versionName   = "2.0"

        // ML Kit's on-device text reader (scan import) is native code, ~11 MB
        // per ABI. Phones are ARM; drop this line to build for an x86 emulator.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    // The viewer is not copied into the app: viewer_build/ itself is an asset
    // folder, so viewer.html and libs/ ship exactly as they are in the repo and
    // a viewer fix needs nothing but a rebuild. The map list lives in
    // src/main/flexfield-assets. (src/main/assets is left out on purpose: it
    // holds the old per-cave payloads, which must not end up in this APK.)
    sourceSets {
        getByName("main") {
            assets.setSrcDirs(listOf("src/main/flexfield-assets", "../../viewer_build"))
        }
    }

    buildTypes {
        release {
            // No shrinking: there is little code here and nothing to gain.
            isMinifyEnabled  = false
            isShrinkResources = false
            // Sideload builds are signed with the debug key so `assembleRelease`
            // produces something installable without a keystore ceremony.
            signingConfig = signingConfigs.getByName("debug")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    // lintVital on release builds costs time and adds nothing to a sideloaded APK.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    // "Import shots from scan": ML Kit Text Recognition v2, Latin script, the
    // BUNDLED artifact. Its model ships inside the APK, so pages are read offline
    // with no Play Services download (the unbundled play-services-mlkit-text-
    // recognition would fetch the model over the network instead).
    implementation("com.google.mlkit:text-recognition:16.0.1")
}
