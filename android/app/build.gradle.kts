import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Cave identity comes from cave.properties, which tools/assemble_assets.py
// rewrites whenever it packs a new export. Giving each cave its own
// applicationId means several of them install side by side rather than
// replacing one another, and the launcher label says which is which.
val caveProps = Properties().apply {
    val f = rootProject.file("cave.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val caveName: String = caveProps.getProperty("cave.name", "Viewer")
val caveId:   String = caveProps.getProperty("cave.id", "cave")

android {
    namespace = "com.feroz.flexviewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.feroz.flexviewer.$caveId"
        minSdk        = 26
        targetSdk     = 34
        versionCode   = 1
        versionName   = "1.0"

        // Defined here rather than in strings.xml so it tracks cave.properties;
        // declaring it in both places would be a duplicate-resource error.
        resValue("string", "app_name", "FLEX $caveName")
    }

    // The cave payload is already-compressed imagery and geometry. Re-deflating
    // it in the APK costs build time and a lot of RAM for essentially no size
    // win, and forces a slow inflate on every read at runtime. Store it raw.
    androidResources {
        noCompress += listOf("glb", "webp", "jpg", "jpeg", "png", "bin")
    }

    buildTypes {
        release {
            // No shrinking: there is almost no code here, and R8 on a 180 MB
            // asset tree buys nothing but build time.
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

    // lintVital runs automatically on release builds. There are ~200 lines of
    // Kotlin here and 133 MB of assets it has no opinion about, so it costs
    // build time and contributes nothing to a sideloaded APK.
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
}
