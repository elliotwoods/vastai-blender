#Install system packages
apt-get install -y vim netcat curl libglu1-mesa-dev libxi6 libxrender1 libfontconfig1 libxxf86vm-dev libxfixes-dev libgl1-mesa-glx libxkbcommon-dev

#Install Blender
pushd ~
wget https://mirror.freedif.org/blender/release/Blender3.4/blender-3.4.0-linux-x64.tar.xz
unxz blender-3.4.0-linux-x64.tar.xz
tar -xvf blender-3.4.0-linux-x64.tar
popd

#Create folders
mkdir ~/output
mkdir ~/scenes