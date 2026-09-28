const express=require("express");
const cors=require("cors");
const {Pool}=require("pg");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
require("dotenv").config();

const app=express();
app.use(cors({origin:true,credentials:true}));
app.use(express.json({limit:"1mb"}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const secret=process.env.JWT_SECRET||"change-this-secret";
const q=async(sql,args=[])=>pool.query(sql,args);
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

async function initDb(){
 await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
 await q(`CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created_at TIMESTAMPTZ DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS categories(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,slug TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS products(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,slug TEXT UNIQUE NOT NULL,description TEXT,price NUMERIC(14,2) NOT NULL DEFAULT 0,stock INT NOT NULL DEFAULT 0,image_url TEXT,category_id UUID REFERENCES categories(id) ON DELETE SET NULL,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS cart_items(user_id UUID REFERENCES users(id) ON DELETE CASCADE,product_id UUID REFERENCES products(id) ON DELETE CASCADE,quantity INT CHECK(quantity>0),PRIMARY KEY(user_id,product_id))`);
 await q(`CREATE TABLE IF NOT EXISTS orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID REFERENCES users(id),total NUMERIC(14,2) NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',shipping_name TEXT,shipping_phone TEXT,shipping_address TEXT,created_at TIMESTAMPTZ DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS order_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID REFERENCES orders(id) ON DELETE CASCADE,product_id UUID,product_name TEXT,unit_price NUMERIC(14,2),quantity INT)`);
 await q(`INSERT INTO categories(name,slug) VALUES('Nông sản','nong-san'),('Cà phê','ca-phe'),('Rau củ','rau-cu') ON CONFLICT(slug) DO NOTHING`);
 await q(`INSERT INTO products(name,slug,description,price,stock,image_url,category_id) SELECT 'Cà phê Arabica Đà Lạt','arabica-da-lat','Cà phê rang mộc',185000,100,'https://images.unsplash.com/photo-1447933601403-0c6688de566e',id FROM categories WHERE slug='ca-phe' ON CONFLICT(slug) DO NOTHING`);
 if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){
  const email=process.env.ADMIN_EMAIL.toLowerCase();
  const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
  await q(`INSERT INTO users(name,email,password_hash,role) VALUES('Administrator',$1,$2,'admin') ON CONFLICT(email) DO UPDATE SET role='admin'`,[email,hash]);
 }
}
function auth(req,res,next){
 try{const t=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!t)return res.status(401).json({message:"Unauthorized"});req.user=jwt.verify(t,secret);next()}catch(e){return res.status(401).json({message:"Invalid token"})}
}
function admin(req,res,next){if(req.user?.role!=="admin")return res.status(403).json({message:"Admin only"});next()}
function slugify(s){return String(s||"").toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}
function token(user){return jwt.sign({id:user.id,name:user.name,email:user.email,role:user.role},secret,{expiresIn:"7d"})}

app.get("/",(req,res)=>res.json({name:"Ecommerce API",version:"2.0.0",status:"running"}));
app.get("/health",wrap(async(req,res)=>{await q("select 1");res.json({status:"ok",database:"connected"})}));
app.post("/api/auth/register",wrap(async(req,res)=>{
 const {name,email,password}=req.body;
 if(!name||!email||!password||password.length<6)return res.status(400).json({message:"Name, email and password (min 6 chars) are required"});
 const hash=await bcrypt.hash(password,12);
 try{const r=await q("insert into users(name,email,password_hash) values($1,$2,$3) returning id,name,email,role",[name,email.toLowerCase(),hash]);res.status(201).json({user:r.rows[0],token:token(r.rows[0])})}
 catch(e){if(e.code==="23505")return res.status(409).json({message:"Email already exists"});throw e}
}));
app.post("/api/auth/login",wrap(async(req,res)=>{
 const r=await q("select * from users where email=$1",[String(req.body.email||"").toLowerCase()]);
 const u=r.rows[0];if(!u||!(await bcrypt.compare(req.body.password||"",u.password_hash)))return res.status(401).json({message:"Invalid credentials"});
 delete u.password_hash;res.json({user:u,token:token(u)});
}));
app.get("/api/me",auth,wrap(async(req,res)=>{const r=await q("select id,name,email,role,created_at from users where id=$1",[req.user.id]);res.json(r.rows[0])}));
app.patch("/api/me",auth,wrap(async(req,res)=>{const {name}=req.body;if(!name)return res.status(400).json({message:"Name required"});const r=await q("update users set name=$1 where id=$2 returning id,name,email,role",[name,req.user.id]);res.json(r.rows[0])}));

app.get("/api/categories",wrap(async(req,res)=>res.json((await q("select * from categories order by name")).rows)));
app.get("/api/products",wrap(async(req,res)=>{
 const {q:search,category,minPrice,maxPrice,sort="newest",limit=24,offset=0}=req.query;
 const vals=[],where=[];if(search){vals.push("%"+search+"%");where.push("(p.name ilike $"+vals.length+" or p.description ilike $"+vals.length+")")}
 if(category){vals.push(category);where.push("c.slug=$"+vals.length)}
 if(minPrice){vals.push(Number(minPrice));where.push("p.price >= $"+vals.length)}
 if(maxPrice){vals.push(Number(maxPrice));where.push("p.price <= $"+vals.length)}
 const order={newest:"p.created_at DESC",price_asc:"p.price ASC",price_desc:"p.price DESC",name:"p.name ASC"}[sort]||"p.created_at DESC";
 const lim=Math.min(Math.max(Number(limit)||24,1),100),off=Math.max(Number(offset)||0,0);vals.push(lim,off);
 const sql="select p.*,c.name category_name,c.slug category_slug from products p left join categories c on c.id=p.category_id "+(where.length?"where "+where.join(" and "):"")+" order by "+order+" limit $"+(vals.length-1)+" offset $"+vals.length;
 const rows=(await q(sql,vals)).rows;res.json(rows);
}));
app.get("/api/products/:id",wrap(async(req,res)=>{const r=await q("select p.*,c.name category_name,c.slug category_slug from products p left join categories c on c.id=p.category_id where p.id=$1 or p.slug=$1",[req.params.id]);if(!r.rows[0])return res.status(404).json({message:"Product not found"});res.json(r.rows[0])}));
app.get("/api/cart",auth,wrap(async(req,res)=>res.json((await q("select ci.product_id,ci.quantity,p.name,p.price,p.image_url,p.stock,p.price*ci.quantity subtotal from cart_items ci join products p on p.id=ci.product_id where ci.user_id=$1",[req.user.id])).rows)));
app.post("/api/cart",auth,wrap(async(req,res)=>{const {productId,quantity=1}=req.body;if(!productId||Number(quantity)<1)return res.status(400).json({message:"Invalid cart item"});const p=await q("select stock from products where id=$1",[productId]);if(!p.rows[0])return res.status(404).json({message:"Product not found"});await q("insert into cart_items(user_id,product_id,quantity) values($1,$2,$3) on conflict(user_id,product_id) do update set quantity=cart_items.quantity+excluded.quantity",[req.user.id,productId,Number(quantity)]);res.status(201).json({message:"Cart updated"})}));
app.patch("/api/cart/:id",auth,wrap(async(req,res)=>{const n=Math.max(1,Number(req.body.quantity)||1);await q("update cart_items set quantity=$1 where user_id=$2 and product_id=$3",[n,req.user.id,req.params.id]);res.json({message:"Updated"})}));
app.delete("/api/cart/:id",auth,wrap(async(req,res)=>{await q("delete from cart_items where user_id=$1 and product_id=$2",[req.user.id,req.params.id]);res.status(204).end()}));

app.post("/api/orders",auth,wrap(async(req,res)=>{
 const c=await pool.connect();try{await c.query("begin");
 const cart=(await c.query("select ci.product_id,ci.quantity,p.name,p.price,p.stock from cart_items ci join products p on p.id=ci.product_id where ci.user_id=$1 for update",[req.user.id])).rows;
 if(!cart.length){await c.query("rollback");return res.status(400).json({message:"Cart empty"})}
 if(cart.some(x=>x.quantity>x.stock)){await c.query("rollback");return res.status(400).json({message:"Insufficient stock"})}
 const total=cart.reduce((a,x)=>a+Number(x.price)*x.quantity,0);
 const o=(await c.query("insert into orders(user_id,total,shipping_name,shipping_phone,shipping_address) values($1,$2,$3,$4,$5) returning *",[req.user.id,total,req.body.shippingName,req.body.shippingPhone,req.body.shippingAddress])).rows[0];
 for(const x of cart){await c.query("insert into order_items(order_id,product_id,product_name,unit_price,quantity) values($1,$2,$3,$4,$5)",[o.id,x.product_id,x.name,x.price,x.quantity]);await c.query("update products set stock=stock-$1,updated_at=now() where id=$2",[x.quantity,x.product_id])}
 await c.query("delete from cart_items where user_id=$1",[req.user.id]);await c.query("commit");res.status(201).json(o);
 }catch(e){await c.query("rollback");throw e}finally{c.release()}
}));
app.get("/api/orders",auth,wrap(async(req,res)=>res.json((await q("select * from orders where user_id=$1 order by created_at desc",[req.user.id])).rows)));
app.get("/api/orders/:id",auth,wrap(async(req,res)=>{const o=await q("select * from orders where id=$1 and user_id=$2",[req.params.id,req.user.id]);if(!o.rows[0])return res.status(404).json({message:"Order not found"});const items=await q("select * from order_items where order_id=$1",[req.params.id]);res.json({...o.rows[0],items:items.rows})}));
app.get("/api/admin/products",auth,admin,wrap(async(req,res)=>res.json((await q("select p.*,c.name category_name from products p left join categories c on c.id=p.category_id order by p.created_at desc")).rows)));
app.post("/api/admin/products",auth,admin,wrap(async(req,res)=>{
 const {name,slug,description="",price,stock=0,imageUrl,categoryId}=req.body;if(!name||price==null)return res.status(400).json({message:"Name and price required"});
 const r=await q("insert into products(name,slug,description,price,stock,image_url,category_id) values($1,$2,$3,$4,$5,$6,$7) returning *",[name,slug||slugify(name),description,Number(price),Number(stock),imageUrl||null,categoryId||null]);res.status(201).json(r.rows[0]);
}));
app.patch("/api/admin/products/:id",auth,admin,wrap(async(req,res)=>{
 const {name,slug,description,price,stock,imageUrl,categoryId}=req.body;const r=await q("update products set name=coalesce($1,name),slug=coalesce($2,slug),description=coalesce($3,description),price=coalesce($4,price),stock=coalesce($5,stock),image_url=coalesce($6,image_url),category_id=$7,updated_at=now() where id=$8 returning *",[name,slug,description,price==null?null:Number(price),stock==null?null:Number(stock),imageUrl||null,categoryId||null,req.params.id]);if(!r.rows[0])return res.status(404).json({message:"Not found"});res.json(r.rows[0]);
}));
app.delete("/api/admin/products/:id",auth,admin,wrap(async(req,res)=>{await q("delete from products where id=$1",[req.params.id]);res.status(204).end()}));
app.post("/api/admin/categories",auth,admin,wrap(async(req,res)=>{const {name,slug}=req.body;if(!name)return res.status(400).json({message:"Name required"});const r=await q("insert into categories(name,slug) values($1,$2) returning *",[name,slug||slugify(name)]);res.status(201).json(r.rows[0])}));
app.get("/api/admin/orders",auth,admin,wrap(async(req,res)=>res.json((await q("select o.*,u.name customer_name,u.email customer_email from orders o join users u on u.id=o.user_id order by o.created_at desc")).rows)));
app.patch("/api/admin/orders/:id/status",auth,admin,wrap(async(req,res)=>{const allowed=["pending","confirmed","shipping","completed","cancelled"];if(!allowed.includes(req.body.status))return res.status(400).json({message:"Invalid status"});const r=await q("update orders set status=$1 where id=$2 returning *",[req.body.status,req.params.id]);if(!r.rows[0])return res.status(404).json({message:"Not found"});res.json(r.rows[0])}));

app.use((err,req,res,next)=>{console.error(err);if(err.code==="23505")return res.status(409).json({message:"Duplicate value"});res.status(500).json({message:"Internal server error"})});
const port=process.env.PORT||3000;
initDb().then(()=>app.listen(port,"0.0.0.0",()=>console.log("Ecommerce API ready on "+port))).catch(e=>{console.error("DB initialization failed",e);process.exit(1)});
