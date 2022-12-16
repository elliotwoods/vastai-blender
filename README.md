# Introduction

A set of scripts for easy handling Blender renders on vast.ai instances. We use https://medium.com/@yani/blender-rendering-on-vast-ai-b77a20d1847d as a starting reference.

This script uses https://github.com/andreafabrizi/Dropbox-Uploader (included here under GPL v3.0). We could instead use rclone which works better for synchronising files (detecting changes), but rclone requires access to the entire of your dropbox account, which isn't recommended when working on a vast.ai instance when you can't 100% trust the operator of the machine that you're giving access to.

# Usage

## 1. Create the instance

Go to Vast.ai and create an instance with image `nvidia/cuda:11.4.1-cudnn8-devel-ubuntu20.04`. You will need some credit in your account in order to create the instance. Generally I've just been keeping the default 10GB of storage but of course extend that if you need to. Remember to delete the instance after you've used it, as you'll have to pay for this storage every day that it's kept on the server. Wait for the instance to be created.

## 2. Login to and setup the instance

You'll find the instance in https://console.vast.ai/instances/ . Connect using SSH.

Perform setup using:

```
git clone https://github.com/elliotwoods/vastai-scripts
cd vastai-scripts
./setup.sh
```

Now perform the Dropbox config. If you're Elliot then use the keys from this app: https://www.dropbox.com/developers/apps/info/xlianiquhxnhdg6#settings

Otherwise : you'll need to craete your own app (dropbox_uploader.sh will guide you). Ideally setup an app that only has access to one folder (not the entire of your Dropbox : especially with vastai you never know who might access your files).

## 4. Setup your dropbox folders

Look inside your dropbox, there should be a folder called `Apps/{whatever you named your app}`, in my case this is at `C:\Users\elliot\Kimchi and Chips Dropbox\Elliot Woods\Apps\Kimchips_Renders`. Setup the following folders inside here:

```
output/
scenes/todo/
scenes/done/
```

Copy any `.blend` files you want to render into the `scenes/todo` folder.

## 4. Perform renders

Now we're ready to render

This script will

1. Downloads contents of `scenes/todo` folder
2. Iterate through `.blend` files in this folder
3. Render the file with all GPU's in CUDA mode 
4. After render completes, uploads results in background (requires to be run in tmux session - which is vastai default)
5. Moves `.blend` file from `scenes/todo` to `scenes/done` folder both locally and on dropbox
6. Repeat from step 2 with next file

Run the script in the SSH session:

```
~/vastai-scripts/download_render_upload.sh
```


# Other commands

## Upload all renders to dropbox

```
./dropbox_uploader.sh -s upload ~/output/* ~/output
```

Note : `-s` excludes pre-existing files on server and must come before the `upload` argument
