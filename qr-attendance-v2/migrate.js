require('dotenv').config();const {Pool}=require('pg');
new Pool({connectionString:process.env.DATABASE_URL}).query(require('fs').readFileSync(__dirname+'/schema.sql','utf8')).then(()=>{console.log('migrated');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});
