#!/usr/bin/python3
from os import listdir, system, mkdir, popen
import queue
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileCreatedEvent
import threading
import time
import sys
from datetime import datetime
import subprocess

user_base_folder = popen("echo $HOME").read().strip()
if user_base_folder == '':
	user_base_folder = '/root'

in_folder = f"{user_base_folder}/scenes/todo"
done_folder = f"{user_base_folder}/scenes/done"

in_folder_remote = 'scenes/todo/'
done_folder_remote = 'scenes/done/'

date_time_string = datetime.now().strftime("%Y-%m-%d_%H.%M.%S")
out_folder = f"{user_base_folder}/output/$(date_time_string)"
mkdir(out_folder)
out_folder_remote = 'output/' + date_time_string

# Check if Octane version is installed at `/usr/local/OctaneBlender/blender` and use that if it is otherwise use default
octane_blender = '/usr/local/OctaneBlender/blender'
default_blender = f"{user_base_folder}/blender-4.3.2-linux-x64/blender"
octane_available = system(f"test -f {octane_blender}") == 0
if octane_available:
    print("Using Octane Blender")
else:
    print("Using default Blender")
    
blender = octane_blender if octane_available else default_blender

dropbox_uploader = f"{user_base_folder}/vastai-scripts/dropbox_uploader.sh"

def is_dry_run():
	return '-d' in sys.argv or '--dry-run' in sys.argv

def run(command):
	print(command)
	if not is_dry_run():
		return system(command) == 0
	return True

def run_blender(command):
    print(command)
    if not is_dry_run():
        process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        previous_was_Fra = False
        while True:
            output = process.stdout.readline()
            if output == "" and process.poll() is not None:
                break
            starts_with_Fra = output.startswith("Fra:")
            if starts_with_Fra and previous_was_Fra:
                print(output.strip() + " ", end="\r", flush=True)
            else:
                print(output.strip())
            previous_was_Fra = starts_with_Fra
        return process.returncode == 0
    return True

# Setup upload queue
upload_queue = queue.Queue()
def upload_thread_action():
	while upload_thread_running:
		try:
			image_file = upload_queue.get(timeout=5)
			# perform upload in other window
			remote_path = out_folder_remote + image_file[len(out_folder):]
			command = "{0} upload \"{1}\" \"{2}\"; tmux wait-for -S upload_done".format(dropbox_uploader, image_file, remote_path)
			print(command)
			system("tmux split-window -h '{0}'".format(command))
			system("wait-for upload_done") # only perform one upload at a time (this maybe isn't working right now)
		except:
			time.sleep(1)		
upload_thread_running = True
upload_thread = threading.Thread(target=upload_thread_action)
upload_thread.start()

# Setup file system watched
class EventHandler(FileSystemEventHandler):
	def on_created(self, event):
		print(event)
		# wait 3seconds first in case of file saving
		time.sleep(3)
		upload_queue.put(event.src_path)

event_handler = EventHandler()
observer = Observer()
observer.schedule(event_handler, out_folder, recursive=True)
observer.start()

# hack - can disable this flag if you want to use the already downloaded scenes instead
do_download = True
do_delete = False

if do_delete:
    # Clear out local and done folders
	run("rm -rf {0}/*".format(in_folder))
	run("rm -rf {0}/*".format(done_folder))
 
if do_download:
	# Download the blender scenes
	run(f"{dropbox_uploader} download {in_folder_remote[:-1]} ~/scenes -s".format(dropbox_uploader))

files_todo = listdir(in_folder)

# if there are no files to do then exit early
if len(files_todo) == 0:
	exit()

for filename in files_todo:
	if not filename.endswith('.blend'):
		continue

	# perform the render
	command = "{3} -b \"{0}/{1}\" -P ~/vastai-scripts/run_startup_scripts.py -P ~/vastai-scripts/enable_gpu.py -o \"{2}/{1}/\" -a".format(in_folder, filename, out_folder, blender)
	render_success = run_blender(command)

	if render_success:	
		# move the file from todo to done locally
		command = "mv \"{1}/{0}\" \"{2}/{0}\"".format(filename, in_folder, done_folder)
		run(command)

		# move the file in drobox also 
		command = "{0} move \"{2}{1}\" \"{3}{1}\" -d".format(dropbox_uploader, filename, in_folder_remote, done_folder_remote)
		run(command)

		print("Finished {0}".format(filename))
	else:
		print("Failed {0}".format(filename))

upload_queue.task_done()
upload_thread_running = False
upload_thread.join()

observer.stop()
observer.join()