#!/usr/bin/env python

import os, re, time
from urllib2 import urlopen
import atexit

instance_id = urlopen("http://169.254.169.254/latest/meta-data/instance-id").read()
base = "https://badaboom.firebaseio-demo.com"

cmd = "curl -s -m 2 http://169.254.169.254/latest/user-data | grep base="
userbase = os.popen(cmd).read().strip()
if userbase:
	base = re.sub("badaboom", userbase.split("=")[1], base)

@atexit.register
def removeBase():
	url = base + "/hqservers/" + instance_id + ".json"
	cmd = "curl -X DELETE " + url
	os.popen(cmd).read()

while 1:
	time.sleep(60)