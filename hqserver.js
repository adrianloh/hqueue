#! /usr/bin/env node
"use strict";

var child_process = require('child_process'),
	fs = require("fs"),
	Q =	require("q"),
	Firebase = require("firebase"),
	request	= require("request"),
	moment = require("moment"),
	amazon = {
		instance_id: "http://169.254.169.254/latest/meta-data/instance-id",
		public_ip: "http://169.254.169.254/latest/meta-data/public-ipv4",
		hostname: "http://169.254.169.254/latest/meta-data/public-hostname",
		dynamic: "http://169.254.169.254/latest/dynamic/instance-identity/document",
		user_data: "http://169.254.169.254/latest/user-data"
	},
	machine = {},
	baseUrl = "https://badaboom.firebaseio-demo.com",
	fileserver = {
		hostname: null,
		mount: null
	},
	base, serversBase, framestoresBase,
	logOut = fs.createWriteStream("/tmp/hqueue-node.log","w"),
	DEFAULT_HQSERVER_INI_URL = "https://smack.s3-ap-southeast-1.amazonaws.com/hqserver.ini",
	LOCAL_HQSERVER_INI_URL = "/opt/hqueue/hqserver.ini";

	Q.all(Object.keys(amazon).map(function(key) {
		var url = amazon[key],
			req = Q.defer();
		request({url:url, timeout: 2000}, function (error, response, body) {
			var user_data = {}, b = (!error && response.statusCode===200) ? body : null;
			if (key==='dynamic') { b = JSON.parse(b); }
			if (key==='user_data') {
				if (b!==null) {
					b.split("\n").map(function(s) { return s.split("="); }).forEach(function(a) { user_data[a[0]] = a[1]; });
				}
				b = user_data;
			}
			req.resolve({key:key, val:b});
		});
		return req.promise;
	})).then(function(results) {
		results.forEach(function(o) {
			machine[o.key] = o.val;
		});
		baseUrl = machine.user_data.hasOwnProperty('base') ? baseUrl.replace(/badaboom/, machine.user_data.base) : baseUrl;
		log("OK: Hqueueserver is up. Establishing base @ " + baseUrl);
		base = new Firebase(baseUrl);
		serversBase = base.child("servers");
		framestoresBase = base.child("framestores");
		framestoresBase.on("value", function(s) {
			var instances = s.val();
			// Remember, this is also null when the framestores ref gets removed
			if (instances!==null) {
				processFramestore(instances);
			}
		});
		framestoresBase.on("child_removed", function(s) {
			if (s.name()===fileserver.instance_id) {
				restartServing(); // We're not OK, serve localhost
			}
		});
	});

	function log(str) {
		var msg = "[" + machine.instance_id + "] [" + moment().add("hours",8).format('LLL') + "] " + str;
		logOut.write(msg+"\n");
	}

	function isServingFileserver(hostname) {
		return null;
		var re = new RegExp(hostname);
		return fs.readFileSync(LOCAL_HQSERVER_INI_URL,{encoding:'utf8'}).match(re);
	}

	function processFramestore(instances) {
		var framestoresCount = Object.keys(instances).length,
			fs_name, fs_details, fileserverData, framestoreData;
		log("Found NUMBER framestore instance(s)".replace(/NUMBER/, framestoresCount.toString()));
		for (var framestoreInstanceId in instances) {
			framestoreData = instances[framestoreInstanceId];
			if (framestoreData.hasOwnProperty('hostname') &&
				framestoreData.hasOwnProperty('filesystems')) {
				log("Selecting framestore instance [INSTANCE] @ ".replace(/INSTANCE/, framestoreInstanceId) + framestoreData.hostname);
				for (fs_name in framestoreData.filesystems) {
					fs_details = framestoreData.filesystems[fs_name];
					if (fs_details.hasOwnProperty('status') &&
						fs_details.status==='online' &&
						fs.existsSync(fs_details.mount) &&
						isServingFileserver(framestoreData.hostname)===null) {
						fileserverData = {
							hostname: framestoreData.hostname,
							instance_id: framestoreInstanceId,
							mount: fs_details.mount
						};
						restartServing(fileserverData);
					}
				}
			}
		}
	}

	function restartServing(_fileserver) {
		var defaults = {
			"hqserver.sharedNetwork.host": "localhost",
			"hqserver.sharedNetwork.path.linux": "%(here)s/shared",
			"hqserver.sharedNetwork.path.windows": "hq",
			"hqserver.sharedNetwork.path.macosx": "%(here)s/HQShared",
			"hqserver.sharedNetwork.mount.linux": "/mnt/hq",
			"hqserver.sharedNetwork.mount.windows": "H:",
			"hqserver.sharedNetwork.mount.macosx": "/Volumes/HQShared"
		};
		if (typeof(_fileserver)==='undefined') {
			// If we're not passed _fileserver, it means the fileserver is down
			// and we reset to point to ourselves
			_fileserver.hostname = "localhost";
			_fileserver.mount = "/mnt/hq";
			_fileserver.instance_id = machine.instance_id;
		}
		defaults["hqserver.sharedNetwork.host"] = _fileserver.hostname;
		defaults["hqserver.sharedNetwork.path.linux"] = _fileserver.mount;
		defaults["hqserver.sharedNetwork.mount.linux"] = _fileserver.mount;
		log("Updating settings file with FOLDER @ ".replace(/FOLDER/, _fileserver.mount) + _fileserver.hostname);
		var fileOut = fs.createWriteStream(LOCAL_HQSERVER_INI_URL, "w");
		request(DEFAULT_HQSERVER_INI_URL, function(error, response, body) {
			body.split("\n").forEach(function(line) {
				if (line.match(/FUCKMEDADDY/)) {
					Object.keys(defaults).forEach(function(key){
						var l = key + " = " + defaults[key];
						fileOut.write(l+"\n");
					});
				} else {
					fileOut.write(line+"\n");
				}
			});
			log("Restarting hqserverd: " + machine.hostname);
			child_process.execFile("/opt/hqueue/scripts/hqserverd", ["restart"], function(err, stdout, stderr) {
				fileserver = _fileserver;
				setTimeout(function() {
					request("http://localhost:80", function(error, response, body) {
						if (!error && response.statusCode===200) {
							log("OK: hqserverd restarted. Serving " + _fileserver.mount + " @ " + _fileserver.hostname);
							serversBase.child(machine.instance_id).set({
								hostname: machine.hostname,
								instance_id: machine.instance_id,
								port: 80,
								fileserver: fileserver.hostname,
								mount: fileserver.mount
							});
						} else {
							fileserver = {hostname: null, mount: null};
							log("ERROR: cannot reach hqserverd");
						}
					});
				}, 30000);
			});
		});
	}