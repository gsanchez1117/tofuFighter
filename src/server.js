var admin = require('./admin.js');
// NODE LIBRARIES ////////////////////////////////////////////////////////////
var http	= require('http');
var fs 		= require('fs');
var url 	= require('url');

// uses socket.io 1.0!
var sio		= require('socket.io');

// CONSTANTS /////////////////////////////////////////////////////////////////
const LOG_FILE = "stats.json";
var port	= process.env.PORT || 8000;

// DATA STRUCTURES ///////////////////////////////////////////////////////////
var uid		= 1;	// unique id counter
var clients	= [];	// array of socket.io client objects

// default stats
var stats;

// load data
var loadedStats = false;
try {
	var text = fs.readFileSync(LOG_FILE);
	stats = JSON.parse(text);
	if (text && stats) loadedStats = true;
} catch (e) { }
if (!loadedStats) {
	stats = {
		currentUsers: 0,
		totalUsers: 0,
		log: []
	};
}
// log message
function statlog(msg) {
	stats.log.push("(" + new Date().toLocaleString() + ") " + msg);
}

// startup
stats.currentUsers = 0;

statlog("Spinning up.");

// PROTOCOL //////////////////////////////////////////////////////////////////
//
// SERVER -> CLIENT:
//   {event: 'hi', id: u_id}
//
// CLIENT -> SERVER:
//   {event: 'pos', blah blah}	- rebroadcast message volatile
//   {blah blah blah}			- rebroadcast message
//

function debug(message)
{
	console.log("error: " + message);
}

var mime_types = 
{
	html:"text/html",
	htm:"text/html",
	css:"text/css",
	js:"text/javascript",
	png:"image/png",
	jpg:"image/jpeg",
	ico:"image/vnd.microsoft.icon",
	txt:"text/plain"
};

// SERVER HANDLERS ///////////////////////////////////////////////////////////

function staticFileHandler(filename)
{
	// cache the data ahead of time
	var file = fs.readFileSync(filename, "binary");
	var stats = fs.statSync(filename);
	var etag = '"' + stats.ino + '-' + stats.size + '-' + Date.parse(stats.mtime) + '"';
	
	var i = filename.lastIndexOf(".");
	var content_type = "text/plain";
	if (i != -1) 
	{
		var extension = filename.substring(i+1);
		if (extension != "" && mime_types[extension] != undefined)
			content_type = mime_types[extension];
	}	
	
	var header = {
		"Server": 			"tofu-game",
		"ETag": 			etag,
		"Content-Type": 	content_type,
		"Content-Length": 	file.length
	}
	
	return function(request, response)
	{
		if (request.headers['if-none-match'] != undefined && 
			request.headers['if-none-match'].indexOf(etag) != -1)
		{
			response.writeHead(304);
			response.end();
			return;
		}

		response.writeHead(200, header);  
		response.write(file, "binary");  
		response.end();
	};
}

var root = staticFileHandler("src/index.html");
var handler = {};

function listFile(file) { handler[file] = staticFileHandler(file); }

// list of files on the server
handler["index.html"] 	= root;
handler["socket.io.js"] = staticFileHandler("node_modules/socket.io-client/socket.io.js");

listFile("favicon.ico");
listFile("src/server.js");
listFile("src/utils/constants.js");
listFile("src/utils/createExplosion.js")
listFile("src/tedge/tedge.js");
listFile("src/utils/GSInput.js");
listFile("src/net/ChatCommands.js");
listFile("src/net/net.js");
listFile("src/screens/GSLoadingScreen.js");
listFile("src/screens/GSGame.js");
listFile("src/utils/textSprite.js");
listFile("src/tedge/shaders.js");
listFile("src/tedge/physics.js");

//meshes
listFile("src/meshes/meshes.js");
listFile("src/meshes/smg.js");

//stuff
listFile("src/tedge/particles.js");
listFile("src/utils/glMatrix-0.9.5.min.js");

//entities
listFile("src/entities/GSStaticEntity.js");
listFile("src/entities/GSDynamicEntity.js");
listFile("src/entities/GSMap.js");
listFile("src/entities/GSBullet.js");
listFile("src/entities/GSTofu.js");
listFile("src/entities/GSPlayer.js");
listFile("src/entities/GSNetPlayer.js");
listFile("src/entities/GSHUD.js");


handler["admin"] = admin(stats, statlog);


//////////////
// LOAD GFX	//
//////////////

/**
 * Dynamically adds all image files stores in 'src/assets/gfx' to the server
 */
function loadGFX() {
	fs.readdir("src/assets/gfx", function(err, files) {
		files.forEach((file) => {
			if (file == ".DS_Store") {return}
			var extension = file.split('.').pop();
			if (extension === "png" || extension === "jpg") {
				listFile(`src/assets/gfx/${file}`);
			}
		})
	});
}
loadGFX();

//////////////
//Map Loader//
//////////////

function loadMapFiles(){
	fs.readdir("src/maps", function(err, dirs) {
		dirs.forEach((dir) => {
			if (dir == '.DS_Store') {return}
			fs.readdir("src/maps/" + dir, function(err, files) {
				files.forEach((file) => {
					var extension = file.split('.').pop();
					if (extension === 'png' || extension === 'js'){
						listFile('src/maps/' + dir + '/' + file);
					}
				});
			});
		});
	});
}
loadMapFiles();

// FILE SERVER ///////////////////////////////////////////////////////////////
server = http.createServer(function(req, resp)
{
	var uri = url.parse(req.url).pathname;
	var filename = uri.substring(1);

	if (filename)
	{
		if (handler[filename])
		{
			handler[filename](req, resp);
		}
		else
		{		
			resp.writeHead(404, {"Content-Type": "text/plain"});  
			resp.write("Error 404: file not found");  
			resp.end();
			debug("requested invalid file: '" + filename + "'");			
		}
	}
	else
	{
		root(req, resp);
	}
});

server.listen(port);

// SOCKET.IO SERVER //////////////////////////////////////////////////////////

let MAX_CHAT_COUNT = 10
var chatLog = [];

function broadcastSend(data, except) {
	clients.map(function (C) {
		if (C != except) {
			C.volatile.emit('message', data);
		}
	});
}

function sendServerMessage(message) {
	var newPlayerMessage = {
		event: 'chatMessage',
		id: 0,
		netName: '[Server]',
		message: message
	} 
	broadcastSend(newPlayerMessage, null)
}

var io = sio(server); 
io.on('connection', function(client)
{ 
	if (stats.currentUsers+1 > 50) {
		client.emit('message', {event: "serverFull", id: user_id});
		client.disconnect()
		return
	}

	var request = client.request;
	var IP = request.headers['x-forwarded-for'] || 
		request.connection.remoteAddress || 
		request.socket.remoteAddress ||
		request.connection.socket.remoteAddress || "none";
	statlog("New connection from " + IP);
	// new player connected
	var user_id = uid++;
	var user_name = `Anon_${user_id}`

	clients[user_id] = client;

	stats.totalUsers++;
	stats.currentUsers++;
	
	// incoming ajax
	client.on('message', function(msg)
	{
		//console.log(msg);
		var cast = {};
		cast["event"] = msg["event"];
		if ("pos" in msg) cast["pos"] = msg["pos"];
		if ("vel" in msg) cast["vel"] = msg["vel"];
		if ("accl" in msg) cast["accl"] = msg["accl"];
		if ("rot" in msg) cast["rot"] = msg["rot"];
		if ("rotv" in msg) cast["rotv"] = msg["rotv"];
		if ("isPlane" in msg) cast["isPlane"] = msg["isPlane"];
		if ("roll" in msg) cast["roll"] = msg["roll"];
		if ("pitch" in msg) cast["pitch"] = msg["pitch"];
		if ("keys" in msg) cast["keys"] = msg["keys"];
		if ("id" in msg) cast["id"] = msg["id"];
		if ("side" in msg) cast["side"] = msg["side"];
		if ("netName" in msg) cast["netName"] = msg["netName"];
		if ("message" in msg) cast["message"] = msg["message"];

		if ("netName" in cast) user_name = cast["netName"];
		
		broadcastSend(cast, msg["event"] != "chatMessage" ? client : null);
	}); 
	
	// client disconnect
	client.on('disconnect', function()
	{
		statlog(user_id + " disconnected. [" + IP + "]");
		console.log(user_id + " disconnected.");
		delete clients[user_id];
		stats.currentUsers--;

		//send server message regarding new player
		sendServerMessage(`${user_name} has left`)

		console.log("server count:" + stats.currentUsers);
	});
	
	// begin the handshake
	client.emit('message', {event: "hi", id: user_id});

	console.log("New player with id " + user_id);
	console.log("server count:" + stats.currentUsers);

	//send server message regarding new player
	sendServerMessage(`${user_name} has joined`)
}); 

// heroku shutdown
process.on('SIGTERM', function () {
	statlog("Spinning down.");
	try {
		var s = JSON.stringify(stats);
		fs.writeFileSync(LOG_FILE, s);
	} catch (e) { }
	server.close(function () {
		io.close();
		process.exit(0);
	});
});

