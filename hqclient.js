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
	base, serversBase, framestoresBase,
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
		log("OK: Hqueueclient is up. Establishing base @ " + baseUrl);
		base = new Firebase(baseUrl);
		serversBase = base.child("servers");
	});

	function log(str) {
		var msg = "[" + machine.instance_id + "] [" + moment().add("hours",8).format('LLL') + "] " + str;
		logOut.write(msg+"\n");
	}