# Setup

```
git clone https://github.com/elliotwoods/vastai-scripts
cd vastai-scripts
./setup.sh
```

Now perform the Dropbox config, check here for keys: https://www.dropbox.com/developers/apps/info/xlianiquhxnhdg6#settings

# Usage

This will perform renders in todo folder and upload results back to dropbox:

```
cd vastai-scripts
./dropbox_uploader.sh download scenes/todo ~/scenes
./do_renders.sh
```
