const fs = require("fs");
const path = require("path");
const spawn = require('child_process').spawn;

const AWS = require("aws-sdk");
const Shell = require('node-powershell');
const tempfile = require('tempfile');
const sleep = require('await-sleep');
const Spinner = require('cli-spinner').Spinner;
const dot = require("dot");
    dot.templateSettings.strip = false;    
    dot.log = false;
    const dots = dot.process({ path: path.join(__dirname, "dot")});





const config_dir = `${process.env.ProgramData || "."}/.ec2_cn/`;
let _cfg_init = {
    profiles : [],
    regions : [],
    key_store : config_dir
};
let _cfg = _cfg_init;

const cfg_path = path.join(config_dir, "cfg.json");
if( fs.existsSync(cfg_path) ){
    _cfg = JSON.parse(fs.readFileSync(cfg_path));
}


async function describeEc2Instance(ec2Id, profile, region){
    
    let creds = new AWS.SharedIniFileCredentials({profile: profile});

    let ec2 = new AWS.EC2({
        credentials : {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken
        }, 
        region :region,
        _id : profile + region
    });


    let params = {
        InstanceIds: [
            ec2Id
        ]
    };
    return ec2.describeInstances( params ).promise().then( r=> {

        return {
            Reservations : r.Reservations,
            region : region,
            profile : profile,
            ec2_sdk : ec2
        };

    }).catch( e=> {
        return {
            Reservations : [],
            region : region,
            profile : profile,
            ec2Id : ec2Id
        };
    });
}

const f = (a, b) => [].concat(...a.map(d => b.map(e => [].concat(d, e))));
const cartesian = (a, b, ...c) => (b ? cartesian(f(a, b), ...c) : a)


async function _(ec2Id){

    //check creds
    //todo: hold state and only check every 5 mins
    for(let i = 0; i < _cfg.profiles.length; i++ ){
        let profile = _cfg.profiles[i];

        let creds = new AWS.SharedIniFileCredentials({profile: profile});
        let sts = new AWS.STS({ credentials : creds });

        try{
            await sts.getCallerIdentity().promise();
        }   
        catch(ex){
            throw {message : `profile - ${profile} - is expired`};
        }
        process.stdout.write(".");
    }


    let promises =  cartesian(_cfg.profiles, _cfg.regions).map( r => {
        process.stdout.write("+");
        return describeEc2Instance( ec2Id, r[0], r[1]);
    });

    let rs = await Promise.all(promises);

    let q = rs.find( r=> r.Reservations.length);
    if( !q ){
        throw {message : `ec2 ${ec2Id} not found`};
    }

    let ec2 = q.Reservations[0].Instances[0];
    process.stdout.write("-->\n");

    let key_path = path.join( _cfg.key_store, `${ec2.KeyName}.pem`);
    if( !fs.existsSync(key_path)){
        throw { message :  `missing ec2 key - ${ec2.KeyName} in ${_cfg.key_store}` };
    }

    console.log( `${ec2Id} @ ${ec2.PrivateIpAddress} ${q.profile},${q.region}`);
    var spinner = new Spinner();
    spinner.start();

    //let pw_data = await  q.ec2_sdk.getPasswordData({ InstanceId: ec2Id }).promise();

    //const key = new NodeRSA();
    //key.importKey(fs.readFileSync(key_path), "pkcs1-private");
    //let key = new NodeRSA(fs.readFileSync(key_path));
       

    //use powershell to get ec2 password and build secure-string for .rdp file
    const ps = new Shell({
        executionPolicy: 'Bypass',
        noProfile: true
    });
       
    ps.addCommand(`$rs = ConvertFrom-Json (aws ec2 get-password-data --instance-id ${ec2Id} --region ${q.region} --priv-launch-key ${key_path} --profile ${q.profile} | out-string)` );
    ps.addCommand(`$s = ConvertTo-SecureString -String ($rs.PasswordData) -AsPlainText -Force`);
    ps.addCommand("ConvertFrom-SecureString -SecureString $s");

    let pwd = await ps.invoke();
    let s = dots.rdp({
        ip : ec2.PrivateIpAddress,
        pwd : pwd
    });

    let tf = tempfile('.rdp');
    fs.writeFileSync( tf, s );

    
    //launch RDP
    //todo: truly detach????
    const subprocess = spawn("mstsc.exe", [tf], {
        detached: true,
        stdio: 'ignore'
      });
      
      subprocess.on( "close",  (code, signal) => {
        process.exit();
      });
  
    spinner.stop(true);
    await sleep(2000);
     fs.unlinkSync(tf); //clean up tempfile

}


const argv = require('yargs')
    .alias( 'i', 'id')
        .describe('i', 'ec2 instance-id')
    .command(['cn [i]','$0 [i]' ], 'connect to ec2', (yargs) => {
        yargs
            .positional('i', {
                describe: 'ec2 instance-id'
            });
    }, async (argv) => {
        try{

            if (!argv.id){
                throw {message : "ec2 instance-id is required"};
            }

            if( !_cfg.regions.length || !_cfg.profiles.length ){
                throw {message : "Invalid config, use cfg command to update."};
            }

           await _(argv.id); //do the needful
        }
        catch(ex){
            console.error(ex.message);
        }
    })
    .command('cfg', 'manage config', (yargs) => {
    }, async (argv) => {

        if( argv.k){
            _cfg.key_store = argv.k;
            fs.writeFileSync(cfg_path, JSON.stringify(_cfg));
        }

        if( argv.p){
            _cfg.profiles = argv.p.split(",");
            fs.writeFileSync(cfg_path, JSON.stringify(_cfg));
        }

        if( argv.r){
            _cfg.regions = argv.r.split(",");
            fs.writeFileSync(cfg_path, JSON.stringify(_cfg));
        }

        if( argv.f ){
            if ( fs.existsSync(argv.f)){
                _cfg = JSON.parse(fs.readFileSync(argv.f));
                fs.copyFileSync(argv.f, cfg_path);
            }
        }

        console.log(JSON.stringify(_cfg));
    })
    .alias( 'k', 'keystore')
        .describe('k', 'cfg keystore path')
    .alias( 'p', 'profiles')
        .describe('p', 'cfg profiles (comma delim)')
    .alias( 'r', 'regions')
        .describe('r', 'cfg regions (comma delim)')
    .alias( 'f', 'file')
        .describe('f', 'cfg file')
    .argv;





