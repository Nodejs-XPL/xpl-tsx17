/*jslint node: true, vars: true, nomen: true */
'use strict';

var jsep = require('jsep');
var Events = require('events');
var Util = require('util');

function Model(commander, tsx, xpl, model) {
	this.commander = commander;
	this.xpl = xpl;

	jsep.addBinaryOp('=', 20);
	jsep.addBinaryOp('#', 10);

	var units = model.units;

	var self = this;
	units.forEach(function(unit) {
		var status = unit.status;
		if (typeof (status) === "string") {
			self._addListener(unit, "status", status);
			return;
		}

		for ( var k in status) {
			self._addListener(unit, k, status[k]);
		}
	});

	xpl.on("xpl:xpl-cmnd", function(message) {
		self.commandReceived(message);
	});
}

Util.inherits(Model, Events.EventEmitter);

module.exports = Model;

Model.prototype.commandReceived = function(words) {

}

Model.prototype.initWords = function(words) {
	console.log("Init words ", words);
	for (var i = 0; i < words.length; i++) {
		this.emit("W" + (i), words[i], true);
	}
}

Model.prototype.wordsChanged = function(diff) {
	for (var i = 0; i < diff.length; i++) {
		var di = diff[i];

		console.log("Emit change of #" + di.index + " " + di.value);

		this.emit("W" + (di.index), di.value, false);
	}
}

Model.prototype._addListener = function(unit, statusName, expression) {
	var tree = jsep(expression);

	var list = [];
	listIdentifiers(list, tree);

	console.log("Expression", expression, ": register identifiers :", list);

	var self = this;
	list.forEach(function(identifier) {

		console.log("Add listener " + identifier + " " + unit.device + "/" + statusName);
		self.on(identifier, self._createListener(tree, unit, statusName, identifier, expression));
	});
}

Model.prototype._createListener = function(tree, unit, statusName, identifier, expression) {
	var self = this;
	return function(value, initPhase) {
		var context = {};
		context[identifier] = value;

		// console.log("Exp =>", expression, context)

		var val = evalExpression(tree, context);

		// console.log(" =>", val);

		if (!unit._values) {
			unit._values = {};
		}

		if (unit._values[statusName] === val) {
			return;
		}

		unit._values[statusName] = val;

		var trig = {
			device: unit.device,
			type: statusName
		};

		if (unit['0%'] !== undefined && unit['100%'] !== undefined && unit.units === "%") {
			val = Math.floor((val - unit['0%']) * 100 / (unit['100%'] - unit['0%']));
			trig.units = "%";
		}

		trig.current = val;
		if (initPhase) {
			trig.initPhase = true;
		}

		console.log("Send stat ", trig);

		self.xpl.sendXplStat(trig);
	};
}

function listIdentifiers(list, node) {
	if (node.type === 'Identifier') {
		list.push(node.name);
		return;
	}

	for ( var k in node) {
		var n = node[k];

		if (typeof (n) === "object") {
			listIdentifiers(list, n);
		}
	}
}

function evalExpression(node, context) {
	switch (node.type) {
	case 'Identifier':
		if (context[node.name] === undefined) {
			throw new Error("Unknown identifier '" + node.name + "'");
		}

		return context[node.name];

	case 'Literal':
		return node.value;

	case 'ConditionalExpression':
		var ret = evalExpression(node.test, context);
		if (ret) {
			return evalExpression(node.consequent, context);
		}

		return evalExpression(node.alternate, context);

	case 'BinaryExpression':
		var left = evalExpression(node.left, context);
		var right = evalExpression(node.right, context);

		switch (node.operator) {
		case '#':
			return left & (1 << right);

		case '+':
			return left + right;

		case '-':
			return left - right;

		case '|':
			return left | right;

		case '&':
			return left & right;

		case '/':
			return left / right;

		case '==':
			return left == right;

		case '===':
			return left === right;

		case '!=':
			return left != right;

		case '!==':
			return left !== right;

		case '<':
			return left < right;

		case '<=':
			return left <= right;

		case '>':
			return left > right;

		case '>=':
			return left >= right;

		default:
			throw new Error("Not supported operation '" + node.operator + "'");
		}

	case 'UnaryExpression':
		var exp = evalExpression(node.left, context);

		switch (node.operator) {
		case '-':
			return -exp;

		case '!':
			return !exp;

		case '~':
			return ~exp;

		case '+':
			return +exp;

		default:
			throw new Error("Not supported operation '" + node.operator + "'");
		}

	}
}
