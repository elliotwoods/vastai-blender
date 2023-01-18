# Introduction

A set of scripts for easy handling Blender renders on vast.ai instances. We use https://medium.com/@yani/blender-rendering-on-vast-ai-b77a20d1847d as a starting reference.

https://vast.ai allows you to rent time on very powerful computers (e.g. for machine learning or crypto mining purposes). In general the cost of renting time on a vast.ai machine is significantly lower than other cloud computing services (e.g. cloud renderers for Blender) because these are machines under people's desks, in people's garages, etc. Often they are out-of-use crypto mining rigs.

Also *please avoid spaces in your filenames!*. It should work now, but this was a cause of many errors before.

## Notes on Dropbox-Uploader

This script uses https://github.com/andreafabrizi/Dropbox-Uploader (included here under GPL v3.0). We could instead use rclone which works somewhat better for comparing files when synchronising, but rclone requires access to the entire of your dropbox account, which isn't recommended when working on a vast.ai instance when you can't 100% trust the operator of the machine that you're giving access to.

# Usage

## 1. Setup a computer on Vast AI

## Configure the image

1. Go to Vast.ai console in the Client>Create section. You should see a list of available instances. Generally I use `On-Demand` not `Interruptable`
2. Choose 'EDIT IMAGE & CONFIG...'
3. Select an empty template slot
4. Set the field `Enter full docker image/...` to `nvidia/cuda:11.4.1-cudnn8-devel-ubuntu20.04`
5. Leave the other settings as default (e.g. run interactive shell server)
6. Choose disk space to allocate (often I choose around 10GB, but use your own judgement here)
7. Hit the `SELECT & SAVE` button

## Select a computer to use

Lok through the list of available machines and select one you like. I generally use the following priorities when selecting an instace:

* Sort by `TFlops/$/Hr`
* At least 100Mbps upload speeds

As of 2022-12 I'll pick an instance with a couple of GeForce 3080's

Presuming that you have the right `Instance Configuration` appearing in the top left corner from the last step, you can now select `RENT` button on the computer that you like to use.

You will need some credit in your account in order to create the instance. Remember to delete the instance after you've used it, as you'll have to pay for the storage every day that it's kept on the server. Wait for the instance to be created.


## 2. Login to and setup the instance

You'll find the instance in https://console.vast.ai/instances/ . It might take a listtle while to get running the first time. The `Status` line will show you the output coming out from docker. Note that if the docker image is already available on this machine then it will start up much faster as it won't need to download everything from the internet.

When it's ready, you should see a blue button sayind `>_CONNECT`. Select that to connect (note you'll need to share your public SSH keys with Vast AI for this to work). I presume that you've used SSH before so I won't go into how to connect here.

Once you're logged in and at the bash prompt on the remote machine. Perform setup using:

```
git clone https://github.com/elliotwoods/vastai-scripts
cd vastai-scripts
chmod 777 ./setup.sh
./setup.sh
```

This will download some utils, python bits and pieces and a copy of blender 3.4.0.

Note : the remote will likely be running tmux, so you can multi-task by adding new windows. Check out a tmux tutorial if you're interested in that.

Now perform the Dropbox config. If you're Elliot then use the keys from this app: https://www.dropbox.com/developers/apps/info/xlianiquhxnhdg6#settings

Otherwise : you'll need to craete your own app (dropbox_uploader.sh will guide you). Ideally setup an app that only has access to one folder (not the entire of your Dropbox : especially with vastai you never know who might access your files).

## Side note for more automation

You can also add this as a step for the vast.ai 'On-start script:' when configuring your instance as

```
git clone https://github.com/elliotwoods/vastai-scripts; cd vastai-scripts; chmod 777 ./setup_non_interactive.sh; ./setup_non_interactive.sh
```

Then you will only need to perform the `dropbox_uploader` script later in order to configure dropbox (which requires user interaction).


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
4. Upload images as they are completed (note that if the files already exist - this will not be detected. delete old files first)
5. Moves `.blend` file from `scenes/todo` to `scenes/done` folder both locally and on dropbox
6. Repeat from step 2 with next file

Run the script in the SSH session:

```
~/vastai-scripts/render_watchdog_upload.py

# Or use the old script if you prefer
# ~/vastai-scripts/download_render_upload.py
```


Notes:

1. Make sure your file name doesn't have any spaces in it
2. Use the feature `File>External Resources>Automatically Pack Data` in Blender to ensure all your textures, etc are stored in the blend file

# Other commands

## Upload all renders to dropbox

```
./dropbox_uploader.sh -s upload ~/output/* ~/output
```

Note : `-s` excludes pre-existing files on server and must come before the `upload` argument

## View network traffic

```
sudo apt-get install -y bmon
bmon
```

```
sudo apt-get install -y slurm
slurm -i eth0
```

## View NVidia GPU usage

```
nvidia-smi
```

## Setup GitHub (if elliot)

```
~/vastai-scripts/setup_github_elliot.sh
```

# Todo / Future

* Make this into a Docker image that is good to go
* Web interface?
* Better handling of multiple render servers e.g.
  * They work on seperate folders?
  * They can render different parts of the animation? (e.g. frames 1-100, 101-200, etc)
