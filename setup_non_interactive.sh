#Install system packages
apt-get install -y \
    vim netcat curl htop python3-pip\
    libglu1-mesa-dev libxi6 libxrender1 libfontconfig1 libxxf86vm-dev libxfixes-dev libgl1-mesa-glx libxkbcommon-dev\
    libsm6
pip3 install watchdog

#Install Blender
pushd ~
wget https://download.blender.org/release/Blender4.3/blender-4.3.2-linux-x64.tar.xz
unxz blender-4.3.2-linux-x64.tar.xz
tar -xvf blender-4.3.2-linux-x64.tar
popd

#Create folders
mkdir ~/output
mkdir ~/scenes