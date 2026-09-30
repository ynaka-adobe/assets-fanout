# Scene7 IPS API — Mixed Media Set creation (Java)

Working example that **creates and publishes a Scene7 Mixed Media Set** (images +
adaptive video) via the IPS SOAP API. Reverse-engineered from
[ynakagawa/S7API-Demo](https://github.com/ynakagawa/S7API-Demo); uses the same
`IPSApi-6.6_2013R1.jar` SDK + Axis2 dependencies.

## Files
| File | Purpose |
|---|---|
| `IPSExplore.java` | Auth + `searchAssets` in a folder → member handles (`a|...`) |
| `GetSetDef.java` | Read an existing set's `setDefinition` (learn the format) |
| `ByName.java` | Look up assets by name |
| `CreateMM.java` | **Create a Mixed Media Set** (`createAssetSet`, `subType=MediaSet`) |
| `Publish.java` | Publish (`submitJob` → `ImageServingPublishJob`) |

## Dependencies
Needs `IPSApi-6.6_2013R1.jar` + the `libs/` jars (Axis2, Axiom, etc.). Grab them
from `ynakagawa/S7API-Demo` (its `list_assets.sh` auto-downloads `libs/`), then
place `IPSApi-6.6_2013R1.jar` and `libs/` next to these files.

## Key learnings (the non-obvious bits)
- **Endpoint**: `https://<region>.scene7.com/scene7/services/IpsApiService`
  (e.g. `s7sps1apissl.scene7.com`), namespace `IpsApi/xsd/2013-02-15`.
- **Auth**: `authHeader{user,password,appName,appVersion}`; company handle like `c|9686`.
- **Mixed Media Set** = `createAssetSet` with **`subType="MediaSet"`** (NOT
  `"MixedMedia"`). The `setDefinition` is comma-joined members, each:
  ```
  ${getCatalogId([<handle>])};${getCatalogId([<handle>])};advanced_image;   # image
  ${getCatalogId([<handle>])};${getCatalogId([<handle>])};video;            # video (use the AVS handle)
  ```
- **Publish**: `submitJob` with `ImageServingPublishJob{publishType:"Incremental"|"Full",
  emailSetting:"None"}` (values are case-sensitive; `"none"`/`"never"` are rejected).
  A publish picks up ALL ready-for-publish assets, so a new set is covered even if
  a job is "already running".
- **Delivery**: `https://<domain>/is/image/CEM/<setName>?req=set,json` returns the
  set; view with `.../s7viewers/html5/MixedMediaViewer.html?asset=CEM/<setName>`.

## Build & run
```bash
javac -cp "IPSApi-6.6_2013R1.jar:libs/*" *.java

# 1) list members in a folder
java -cp "IPSApi-6.6_2013R1.jar:libs/*:." IPSExplore \
  "https://s7sps1apissl.scene7.com/scene7/services/IpsApiService" \
  "$S7_user" "$S7_password" "c|9686" "CEM/brand/Brand-11/consumer/"

# 2) create a Mixed Media Set: images then videos (AVS handles)
java -cp "IPSApi-6.6_2013R1.jar:libs/*:." CreateMM \
  "$SERVER" "$S7_user" "$S7_password" "c|9686" \
  "f|CEM/brand/Brand-11/consumer/" "my-mm-set" \
  "a|<img1>,a|<img2>" "a|<video-AVS>"

# 3) publish
java -cp "IPSApi-6.6_2013R1.jar:libs/*:." Publish "$SERVER" "$S7_user" "$S7_password" "c|9686" "Incremental" "None"
```

> **Credentials gotcha**: if your `S7_password` contains `$`, `source .env` will
> mangle it — read the value literally instead of sourcing.

> **App Builder note**: this Java/Axis2 SDK cannot run on Adobe I/O Runtime
> (Node.js only). To run there, re-implement `createAssetSet` + `submitJob` as
> raw SOAP over `fetch` (the schema above is everything you need).
