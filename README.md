# Introduction

A set of scripts for easy handling Blender renders on vast.ai instances. We use https://medium.com/@yani/blender-rendering-on-vast-ai-b77a20d1847d as a starting reference.

# Usage

## 1. Create the instance

Go to Vast.ai and create an instance with image `nvidia/cuda:11.4.1-cudnn8-devel-ubuntu20.04`. You will need some credit in your account in order to create the instance. Generally I've just been keeping the default 10GB of storage but of course extend that if you need to. Remember to delete the instance after you've used it, as you'll have to pay for this storage every day that it's kept on the server. Wait for the instance to be created.

## 2. Login the instance

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

This will perform renders in todo folder and upload results back to dropbox in the `output/` folder

In the SSH session..

```
# Go into the scripts folder
cd ~/vastai-scripts

# Download all scenes from dropbox folder
./dropbox_uploader.sh download scenes/todo ~/scenes -s

# Perform renders and do uploads. Note that uploads will be performed in background whilst next renders are performed
# The script presumes that it is running insde a tmux session (standard for this vastai config)
./do_renders_and_uploads.sh
```
