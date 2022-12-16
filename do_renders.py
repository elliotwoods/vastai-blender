#!/usr/bin/python3
from os import listdir, system

in_folder = '/root/scenes/todo'
done_folder = '/root/scenes/done'
out_folder = '~/output'
blender = '/root/blender-3.4.0-linux-x64/blender'
dropbox_uploader = '/root/vastai-scripts/dropbox_uploader.sh'

for filename in listdir(in_folder):
	if not filename.endswith('.blend'):
		continue

	# perform the render
	command = "{3} -b '{0}/{1}' -P ~/vastai-scripts/enable_gpu.py -o {2}/{1}/ -a".format(in_folder, filename, out_folder, blender)
	print(command)
	#system(command)
	
	# perform upload in other window
	command = "{0} upload {2}/{1} output/".format(dropbox_uploader, filename, out_folder)
	print(command)
	system("tmux split-window \"{0}\"".format(command))

	# move the file from todo to done
	system("mv {1}/{0} {2}/{0}".format(filename, in_folder, done_folder))

	print("Finished {0}".format(filename))