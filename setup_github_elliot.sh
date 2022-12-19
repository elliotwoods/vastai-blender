cd ~/vastai-scripts
git remote rm origin 
git remote add origin git@github.com:elliotwoods/vastai-scripts.git
git config --global user.email "elliot@kimchiandchips.com"
git config --global user.name "Elliot Wooods"
ssh-keygen -t ed25519 -C "elliot@kimchiandchips.com"
cat ~/.ssh/id_ed25519.pub
