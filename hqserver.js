#! /usr/bin/env node

var Popen = require('child_process').exec,
	fs = require("fs"),
	Q =	require("q"),
	Firebase = require("firebase"),
	request	= require("request"),
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
	DEFAULT_HQSERVER_INI_URL = "https://smack.s3-ap-southeast-1.amazonaws.com/hqserver.ini",
	LOCAL_HQSERVER_INI_URL = "/opt/hqueue/hqserver.ini";

	Q.all(Object.keys(amazon).map(function(key) {
		var url = amazon[key],
			req = Q.defer();
		request({url:url, timeout: 2000}, function (error, response, body) {
			var user_data = {}, b = (!error && response.statusCode==200) ? body : null;
			if (key==='dynamic') b = JSON.parse(b);
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
		console.log(machine);
		baseUrl = machine.user_data.hasOwnProperty('base') ? baseUrl.replace(/badaboom/, machine.user_data.base) : baseUrl;
		base = new Firebase(baseUrl);
		serversBase = base.child("servers");
		framestoresBase = base.child("framestores");
		framestoresBase.on("value", function(s) {
			var instances = s.val(),
				fs_name;
			console.log(instances);
			if (instances!==null) {
				for (var instanceId in instances) {
					var instanceData = instances[instanceId];
					if (instanceData.hasOwnProperty('hostname') &&
						instanceData.hasOwnProperty('filesystems')) {
						console.log(instanceData.filesystems);
						for (fs_name in instanceData.filesystems) {
							var fs_details = instanceData.filesystems[fs_name];
							if (fs_details.hasOwnProperty('status') &&
								fs_details.status==='online' &&
								fs.existsSync(fs_details.mount) &&
								isServingFileserver(instanceData.hostname)===null) {
								fileserver.hostname = instanceData.hostname;
								fileserver.mount = fs_details.mount;
								restartServing(fileserver);
							}
						}
					}
				}
			}
		});
	});

	function isServingFileserver(hostname) {
		var re = new RegExp(hostname);
		return fs.readFileSync(LOCAL_HQSERVER_INI_URL,{encoding:'utf8'}).match(re);
	}

	function restartServing(fileserver) {
		var defaults = {
			"hqserver.sharedNetwork.host": "localhost",
			"hqserver.sharedNetwork.path.linux": "%(here)s/shared",
			"hqserver.sharedNetwork.path.windows": "hq",
			"hqserver.sharedNetwork.path.macosx": "%(here)s/HQShared",
			"hqserver.sharedNetwork.mount.linux": "/mnt/hq",
			"hqserver.sharedNetwork.mount.windows": "H:",
			"hqserver.sharedNetwork.mount.macosx": "/Volumes/HQShared"
		};
		defaults["hqserver.sharedNetwork.host"] = fileserver.hostname;
		defaults["hqserver.sharedNetwork.path.linux"] = fileserver.mount;
		defaults["hqserver.sharedNetwork.mount.linux"] = fileserver.mount;
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
			Popen("sudo /opt/hqueue/scripts/hqserverd restart 2>&1", function(err, stdout, stderr) {
				if (stdout.match(/Starting/)) {
					serversBase.child(machine.hostname.replace(/\./g,"-")).set({
						hostname: machine.hostname,
						port: 80,
						mount: fileserver.mount
					});
				}
			});
		});
	}