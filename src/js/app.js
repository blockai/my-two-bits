module.exports = function(options) {

  var commonBlockchain = options.commonBlockchain;
  var network = options.network;
  var commonWalletNonceStore = options.commonWalletNonceStore;
  var commentsStore = options.commentsStore;

  var bitcoin = require('bitcoinjs-lib');

  /*

    app
    ---
    express

     cors
     body-parser
     express-common-wallet

  */

  var defaultCommentSettings = {
    tipToComment: true,
    tipToRead: false
  }

  var express = require('express');
  var cors = require('cors');
  var bodyParser = require('body-parser');
  var rateLimit = require('express-rate-limit');
  var expressCommonWallet = require('express-common-wallet');
  var app = express();
  app.use(cors({
    exposedHeaders: ['x-common-wallet-address', 'x-common-wallet-nonce', 'x-common-wallet-network', 'x-common-wallet-signed-nonce', 'x-common-wallet-verified-address']
  }));
  app.use(bodyParser());
  app.use("/", expressCommonWallet({
    commonWalletNonceStore: commonWalletNonceStore
  }));
  app.enable('trust proxy');

  /*

    verification middleware
    -----------------------

    depends on express-common-wallet router middleware

  */

  var verifyTip = function(req, res, next) {
    var verifiedAddress = req.verifiedAddress; // from express-common-wallet middleware
    var sha1 = req.params.sha1;
    if (sha1 && verifiedAddress) {
      var network = req.headers["x-common-wallet-network"];
      var openpublishState = require('openpublish-state')({
        network: network
      });
      openpublishState.findDoc({sha1:sha1, includeTips: true}, function(err, openpublishDoc) {
        var tips = openpublishDoc.tips;
        tips.forEach(function(tip) {
          if (tip.sourceAddresses[0] === verifiedAddress) {
            req.tipVerified = true;
          }
        });
        if (openpublishDoc && openpublishDoc.sourceAddresses && openpublishDoc.sourceAddresses[0] === verifiedAddress) {
          req.tipVerified = true;
        }
        next();
      });
    }
    else {
      next();
    }
  };

  var verifyAddressAndTip = function(req, res, next) {
    var sha1 = req.params.sha1;
    verifyTip(req, res, function() {
      var verifiedAddress = req.verifiedAddress; // from express-common-wallet middleware
      if (!verifiedAddress) {
        return res.status(401).send("Unauthorized");
      } 
      var tipVerified = req.tipVerified; // from verifyTip middleware
      if (!tipVerified) {
        return res.status(401).send("Missing Opentip: " + sha1);
      }
      next();
    });
  };

  /*

    get and post comments endpoints
    -------------------------------

  */

  app.get("/verify/:sha1", verifyAddressAndTip, function(req, res) {
    res.status(200).send("ok");
  });

  app.get("/comments_count/:sha1",  function(req, res) {
    var sha1 = req.params.sha1;
    commentsStore.get(sha1, function(err, comments) {
      var commentsCount = comments.length;
      if (err) {
        res.status(500).send("Error");
      }
      res.status(200).send(commentsCount.toString());
    });
  });

  app.get("/batch_comments_count/:sha1s",  function(req, res) {
    var sha1s = req.params.sha1s.split(",");
    commentsStore.batchGetCount(sha1s, function(err, commentCounts) {
      if (err) {
        res.status(500).send("Error");
      }
      res.status(200).send(commentCounts);
    });
  });

  var getCommentsMiddleware = function(req, res, next) {
    var commentSettings = defaultCommentSettings;
    if (commentSettings.tipToRead) {
      verifyAddressAndTip(req, res, next);
    }
    else {
      next();
    }
  };

  app.get("/comments/:sha1", getCommentsMiddleware, function(req, res) {
    var sha1 = req.params.sha1;
    commentsStore.get(sha1, function(err, comments) {
      if (err) {
        res.status(500).send("Error");
      }
      res.status(200).send(comments);
    });
  });

  var postCommentLimiter = rateLimit({
    windowMs: 60 * 1000 * 5, // 3 minutes
    max: 3,
    delayAfter: 0,
    delayMs: 0,
    message: "Too many comment posts, please try again later."
  });

  var postCommentMiddleware = function(req, res, next) {    
    var commentSettings = defaultCommentSettings;
    if (commentSettings.tipToComment) {
      verifyAddressAndTip(req, res, function() {
        postCommentLimiter(req, res, next);
      });
    }
    else {
      postCommentLimiter(req, res, next);
    }
  };

  app.post("/comments/:sha1", postCommentMiddleware, function(req, res) {
    var commentBody = req.body.commentBody;
    if (commentBody.length === 0) {
      return res.status(400).send("Empty Comment");
    };
    var sha1 = req.params.sha1;
    var verifiedAddress = req.verifiedAddress; // from express-common-wallet middleware
    var network = req.headers["x-common-wallet-network"] == "testnet" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin; // from express-common-wallet middleware
    var signedCommentBody = req.body.signedCommentBody;
    var commonBodyIsVerified;
    try {
      commonBodyIsVerified = bitcoin.Message.verify(verifiedAddress, signedCommentBody, commentBody, network);
    }
    catch(e) {
      commonBodyIsVerified = false;
    }
    if (!commonBodyIsVerified) {
      return res.status(401).send("Unauthorized Comment");
    }
    var newComment = {
      commentBody: commentBody,
      address: verifiedAddress
    }
    commentsStore.get(sha1, function(err, comments) {
      comments.push(newComment);
      commentsStore.set(sha1, comments, function(err, receipt) {
        if (err) {
          return res.status(500).send("Error");
        }
        res.status(200).send("ok");
      });
    });
  });

  return app;
}
