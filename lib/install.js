
// npm install <pkg> <pkg> <pkg>
// npm install <pkg@version> <pkg@"1.0.0 - 1.99.99"> <pkg[@latest]> <pkg@tagname>

// ALGORITHM 1: Deeper, more repetition, easier to update, faster runtime lookups
// install(where, what, previously)
// fetch what, unpack into where/node_modules
// for each dep in what.dependencies
//   resolve dep to precise version
// for each dep@version in what.dependencies
//     not in previously
//     and not in where/node_modules/what/node_modules
//   install(where/node_modules/what, dep, previously + what)
//
// ALGORITHM 2: Disk efficient, less repetition, more sharing.
// install(where, what, previously)
// fetch what, unpack into where/node_modules
// for each dep in what.dependencies
//   resolve dep to precise version
// for each dep@version in what.dependencies
//     not in where/nm/what/nm/*
//     and not in previously
//   install(where/node_modules/what, dep, previously+precise version deps)
//
// ALGORITHM 3: Most disk efficient, minimum repetition. "Squash left"
// install(where, what, previously)
// fetch what, unpack into where/node_modules
// for each dep in what.dependencies
//   resolve dep to precise version
// list1 = [], list2 = []
// for each dep@version in what.dependencies
//     and not in where/nm/what/nm/*
//     and not in previously
//   if dep not in where/node_modules
//     add dep to list1
//   else add dep to list2
// for each dep@version in list1
//   install(where, dep@version, previously+list1)
// for each dep@version in list2
//   install(where, dep@version, previously+list1+list2)
//
// For package{dep} structure: A{B,C}, B{C}, C{D}
//
// Algorithm 1 produces:
// A
// +-- B
// |   `-- C
// |       `-- D
// `-- C
//     `-- D
//
// Algorithm 2 produces:
// A
// +-- B
// `-- C
//     `-- D
//
// Algorithm 3 produces:
//
// A
// +-- B
// +-- C
// `-- D
//
// At first glance, 2 is clearly better.  However, if A wants to update to
// C', which conflicts with B's dependency on C, then the update algorithm
// must be clever enough to detect this, and install C directly in B.  With
// installation algorithm 1, the update process simply detects that B will
// not be satisfied by C', and leave it alone.
//
// Even though it makes updating slightly more complicated, that complication
// is unavoidable.  `npm update` should always be smart enough to detect
// and prevent contract breakage, even if it was the result of some manual
// intervention.
//
// Algorithm 3 looks nice but is obnoxious.  It's very likely that old deps
// will be left behind when things are removed, even if they're no longer
// necessary, and detecting that will be tricky.  With algo2, however,
// removing C will require a check to make sure that no other packages
// are depending on it.
//
// Conclusion: Use algorithm 1.  Switching is easy anyway.
//
// Managing "previously" lists...
// every time we dive into a deeper node_modules folder, the "previously"
// list that gets passed along uses the previous "previously" list as
// it's __proto__.  Any "resolved precise dependency" things that aren't
// already on this object get added, and then that's passed to the next
// generation of installation.

module.exports = install

install.usage = "npm install <tarball file>"
              + "\nnpm install <tarball url>"
              + "\nnpm install <folder>"
              + "\nnpm install <pkg>"
              + "\nnpm install <pkg>@<tag>"
              + "\nnpm install <pkg>@<version>"
              + "\nnpm install <pkg>@<version range>"
              + "\n\nCan specify one or more: npm install ./foo.tgz bar@stable /some/folder"
              + "\nInstalls dependencies in ./package.json if no argument supplied"

install.completion = function (opts, cb) {
  // install can complete to a folder with a package.json, or any package.
  // if it has a slash, then it's gotta be a folder
  // if it starts with https?://, then just give up, because it's a url
  // for now, not yet implemented.
  var registry = require("./utils/npm-registry-client")
  registry.get("/-/short", function (er, pkgs) {
    if (er) return cb()
    if (!opts.partialWord) return cb(null, pkgs)
    var name = opts.partialWord.split("@").shift()
    pkgs = pkgs.filter(function (p) {
      return p.indexOf(name) === 0
    })
    if (pkgs.length !== 1 && opts.partialWord === name) return cb(null, pkgs)
    registry.get(pkgs[0], function (er, d) {
      if (er) return cb()
      return cb(null, Object.keys(d["dist-tags"] || {})
                .concat(Object.keys(d.versions || {}))
                .map(function (t) {
                  return pkgs[0] + "@" + t
                }))
    })
  })
}

var npm = require("../npm")
  , semver = require("semver")
  , readJson = require("./utils/read-json")
  , log = require("./utils/log")
  , path = require("path")
  , fs = require("./utils/graceful-fs")
  , cache = require("./cache")
  , asyncMap = require("./utils/async-map")
  , chain = require("./utils/chain")
  , relativize = require("./utils/relativize")
  , output
  , url = require("url")
  , tty = require("tty")
  , mkdir = require("./utils/mkdir-p")

function install (args, cb) {

  var where = npm.prefix
  if (npm.config.get("global")) where = path.resolve(where, "lib")

  // internal api: install(what, where, cb)
  if (arguments.length === 3) {
    where = args
    args = [cb]
    cb = arguments[2]
    log([args, where], "install(where, what)")
  }

  // install dependencies locally by default,
  // or install current folder globally
  if (!args.length && tty.isatty(process.stdin.fd)) {
    if (npm.config.get("global")) args = ["."]
    else return readJson(path.resolve("package.json"), function (er, data) {
      if (er) return log.er(cb, "Couldn't read dependencies.")(er)
      var deps = Object.keys(data.dependencies || {})
      if (!deps.length) return log("Nothing to do", "install", cb)
      var previously = {}
      previously[data.name] = data.version
      installMany(deps.map(function (dep) {
        var target = data.dependencies[dep]
        if (!url.parse(target).protocol) {
          target = dep + "@" + target
        }
        return target
      }), where, previously, false, cb)
    })
  }

  // initial "previously" is the name:version of the root, if it's got
  // a pacakge.json file.
  readJson(path.resolve(where, "package.json"), function (er, data) {
    if (er) data = null
    var previously = {}
      , errState
      , i = 2

    if (data) previously[data.name] = data.version

    // piping a tarball in.  install it.
    if (!tty.isatty(process.stdin.fd)) {
      installStdin(where, previously, next)
    } else next()

    if (args.length) installMany(args, where, previously, true, next)
    else next()

    function next (er) {
      if (errState) return
      if (er || (-- i === 0)) return cb(errState = er)
    }
  })
}

function installStdin (where, previously, cb_) {
  mkdir(npm.tmp, function (er) {
    if (er) return cb_(er)

    var tmp = path.resolve(npm.tmp, "stdin.tgz")
      , st = fs.createWriteStream(tmp)
      , errState = null

    function cb (er) {
      process.stdin.removeListener("data", onData)
      if (errState) return
      cb_(errState = er)
    }

    log.verbose("piping stdin to "+tmp)
    //process.stdin.pipe(st)
    process.stdin.on("error", cb)
    process.stdin.on("data", onData)
    process.stdin.on("end", function () { st.end() })
    function onData (c) {
      if (!st.write(c)) process.stdin.pause()
    }
    st.on("drain", function () { process.stdin.resume() })
    st.on("error", cb)
    st.on("close", function () {
      log.verbose([tmp, where, previously], "about to installMany")
      if (errState) return
      installMany([tmp], where, previously, true, cb)
    })
    process.stdin.resume()
  })
}

function installMany (what, where, previously, explicit, cb) {
  log.info(what, "into "+where)
  // what is a list of things.
  // resolve each one.
  asyncMap(what, targetResolver(where, previously, explicit)
          ,function (er, targets) {
    if (er) return cb(er)
    // each target will be a data object corresponding
    // to a package, folder, or whatever that is in the cache now.
    log.silly(targets, "resolved")
    log.info(targets.map(function (t) { return t && t._id})
            , "(resolved) into "+where)
    asyncMap(targets, function (target, cb) {
      log(target._id, "installOne")
      installOne(target, where, previously, cb)
    }, cb)
  })
}

function targetResolver (where, previously, explicit) {
  var alreadyInstalledManually = explicit ? [] : null
    , nm = path.resolve(where, "node_modules")

  if (!explicit) fs.readdir(nm, function (er, inst) {
    if (er) return alreadyInstalledManually = []
    alreadyInstalledManually = inst
  })

  var to = 0
  return function resolver (what, cb) {
    if (!alreadyInstalledManually) return setTimeout(function () {
      resolver(what, cb)
    }, to++)
    // now we know what's been installed here manually,
    // or tampered with in some way that npm doesn't want to overwrite.
    if (alreadyInstalledManually.indexOf(what.split("@").shift()) !== -1) {
      log("skipping "+what, "already installed manually in "+where)
      return cb(null, [])
    }
    cache.add(what, function (er, data) {
      if (!er && data && previously[data.name] === data.version) {
        return cb(null, [])
      }
      return cb(er, data)
    })
  }
}

// we've already decided to install this.  if anything's in the way,
// then uninstall it first.
function installOne (target, where, previously, cb) {
  var nm = path.resolve(where, "node_modules")
    , targetFolder = path.resolve(nm, target.name)

  chain
    ( [checkEngine, target]
    , [checkCycle, target, previously]
    , [checkGit, targetFolder]
    , [write, target, targetFolder, previously]
    , function (er) {
        log.info(target._id || target, "installOne cb")
        if (er) return cb(er)
        if (!npm.config.get("global")) {
          // print out the folder relative to where we are right now.
          // relativize isn't really made for dirs, so you need this hack
          targetFolder = relativize(targetFolder, process.cwd()+"/x")
        }
        output = output || require("./utils/output")
        output.write(target._id+" "+targetFolder, cb)
      }
    )
}

function checkEngine (target, cb) {
  var npmv = npm.version
    , nodev = process.version
    , eng = target.engines
  if (!eng) return cb()
  if (eng.node && !semver.satisfies(nodev, eng.node)
      || eng.npm && !semver.satisfies(npmv, eng.npm)) {
    var er = new Error("Unsupported")
    er.errno = npm.EENGINE
    er.required = eng
    er.pkgid = target._id
    return cb(er)
  }
  return cb()
}


function checkCycle (target, previously, cb) {
  // there are some very rare and pathological edge-cases where
  // a cycle can cause npm to try to install a never-ending tree
  // of stuff.
  // Simplest:
  //
  // A -> B -> A' -> B' -> A -> B -> A' -> B' -> A -> ...
  //
  // Solution: Simply flat-out refuse to install any name@version
  // that is already in the prototype tree of the previously object.

  var p = previously
    , name = target.name
    , version = target.version
  while (p && p !== Object.prototype && p[name] !== version) {
    p = Object.getPrototypeOf(p)
  }
  if (p[name] !== version) return cb()
  var er = new Error("Unresolveable cycle detected")
  er.pkgid = target._id
  er.errno = npm.ECYCLE
  return cb(er)
}

function checkGit (folder, cb) {
  // if it's a git repo then don't touch it!
  fs.lstat(folder, function (er, s) {
    if (er || !s.isDirectory()) return cb()
    else checkGit_(folder, cb)
  })
}

function checkGit_ (folder, cb) {
  fs.stat(path.resolve(folder, ".git"), function (er, s) {
    if (!er && s.isDirectory()) {
      var e = new Error("Appears to be a git repo or submodule.")
      e.path = folder
      e.errno = npm.EISGIT
      return cb(e)
    }
    cb()
  })
}

function write (target, targetFolder, previously, cb_) {
  var up = !npm.config.get("global") || npm.config.get("unsafe-perm")
    , user = up ? null : npm.config.get("user")
    , group = up ? null : npm.config.get("group")

  function cb (er, data) {
    if (!er) return cb_(er, data)
    log.error(er, "error installing "+target._id)
    npm.commands.unbuild([targetFolder], function (er2) {
      if (er2) log.error(er2, "error rolling back "+target._id)
      return cb_(er, data)
    })
  }

  chain
    ( [ npm.commands.unbuild, [targetFolder] ]
    , [ cache.unpack, target.name, target.version, targetFolder
      , null, null, user, group ]
    , function (cb) {
        var deps = Object.keys(target.dependencies || {})
          , newPrev = Object.create(previously)

        newPrev[target.name] = target.version

        installMany(deps.filter(function (d) {
          // prefer to not install things that are satisfied by
          // something in the "previously" list.
          return !semver.satisfies(previously[d], target.dependencies[d])
        }).map(function (d) {
          var t = target.dependencies[d]
          if (!url.parse(t).protocol) {
            t = d + "@" + t
          }
          return t
          return d + "@" + target.dependencies[d]
        }), targetFolder, newPrev, false, function (er) {
          log.verbose(targetFolder, "about to build")
          if (er) return cb(er)
          npm.commands.build([targetFolder], cb)
        })
      }
    , cb )
}
