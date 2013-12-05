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
	hqserver = {
		hostname: null,
		instance_id: null
	},
	baseUrl = "https://badaboom.firebaseio-demo.com",
	base, serversBase, meBase, assetsBase,
	HQCLIENT_LOCATION = "/home/ec2-user/hqclient/",
	HQCLIENT_EXECUTABLE = HQCLIENT_LOCATION + "hqclientd",
	LOCAL_HQNODE_INI_URL = HQCLIENT_LOCATION + "hqnode.ini",
	logOut = fs.createWriteStream("/tmp/hqueue-client-node.log","w");

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
		base = new Firebase(baseUrl);
		meBase = base.child("hqclients").child(machine.instance_id);
		serversBase = base.child("hqservers");
		assetsBase = base.child("assets");

		log("OK: Hqueueclient is up. Establishing base @ " + baseUrl);

		serversBase.on("child_added", function(s) {
			var hqserverData = s.val();
			if (hqserverData!==null) {
				connectToServer(hqserverData);
			}
		});

		serversBase.on("child_removed", function(s) {
			var hqserverData = s.val();
			if (hqserverData!==null) {
				if (hqserverData.instance_id===hqserver.instance_id) {
					log("WARNING: HQserver [" + hqserverData.instance_id + "] is down.");
					hqserver.hostname = null;
					hqserver.instance_id = null;
				}
			}
		});

		assetsBase.on("child_added", function(s) {
			var home = "/home/ec2-user/",
				re_me = new RegExp(machine.instance_id),
				downloadPkg = s.val(), cmd, basename;
			if (downloadPkg!==null &&
				(downloadPkg.siapa.match(/all/) || downloadPkg.siapa.match(re_me))) {

				s.ref().child("workers").transaction(function(o) {
					if (o===null) { o = {}; }
					o[machine.instance_id] = "downloading";
					return o;
				});

				log("Downloading " + downloadPkg.src);

				if (downloadPkg.src.match(/tgz/) || downloadPkg.src.match(/tar.gz/)) {
					cmd = 'curl -so - "SRC" | tar xvzf - -C '.replace(/SRC/, downloadPkg.src);
					cmd+= downloadPkg.unzip_to;
				} else {
					basename = path.basename(downloadPkg.src);
					cmd = 'wget "SRC" -O '.replace(/SRC/, downloadPkg.src);
					cmd+= (downloadPkg.unzip_to + "/" + basename);
				}
				child_process.exec(cmd, {cwd:home}, function(err, stdout, stderr) {
					if (!err) {
						s.ref().child("workers").transaction(function(o) {
							if (o===null) { o = {}; }
							o[machine.instance_id] = "done";
							return o;
						});
						log("Done processing " + downloadPkg.src);
					}
				});
			}
		});
	});

	function log(str) {
		var msg = "[" + machine.instance_id + "] [" + moment().add("hours",8).format('LLL') + "] " + str;
		logOut.write(msg+"\n");
		if (typeof(meBase)!=='undefined') {
			meBase.child("log").set(msg);
		}
	}

	function connectToServer(_hqserver) {
		var defaults = {
			"server": "localhost",
			"port": 80,
			"sharedNetwork.mount" : "/mnt/hq"
		};
		if (typeof(_hqserver)!=='undefined') {
			defaults.server = _hqserver.hostname;
			defaults.port = _hqserver.port;
			defaults["sharedNetwork.mount"] = _hqserver.mount;
		}
		log("Updating hqserver ==> " + _hqserver.hostname);
		log("Using shared folder from " + _hqserver.fileserver + " mounted @ " + _hqserver.mount);
		var fileOut = fs.createWriteStream(LOCAL_HQNODE_INI_URL, "w");

		// Write the body of the .ini file
		fileOut.write("[main]\n");
		Object.keys(defaults).forEach(function(key) {
			var line = key + " = " + defaults[key].toString() + "\n";
			fileOut.write(line);
		});
		fileOut.write("[job_environment]");

		log("Restarting hqclientd: " + machine.hostname);
		child_process.execFile(HQCLIENT_EXECUTABLE, ["restart"], function(err, stdout, stderr) {
			if (stdout.match(/success/)) {
				log("OK: Restarted hqclientd: " + machine.hostname);
				hqserver.hostname = _hqserver.hostname;
				hqserver.instance_id = _hqserver.instance_id;
			} else {
				log("ERROR: Did not acquire success from hqclientd restart");
			}
		});
	}