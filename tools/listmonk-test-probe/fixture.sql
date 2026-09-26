-- Synthetic, empty CI database only. No scheduled campaigns, customers or app SQL.
INSERT INTO settings(key,value) VALUES('migrations','["v6.1.0"]');
INSERT INTO roles(id,type,name,permissions) VALUES(1,'user','Synthetic superadmin',ARRAY['*']);
INSERT INTO users(username,password,email,name,type,user_role_id,status)
 VALUES('synthetic-api','synthetic-probe-token','operator@example.invalid','Synthetic operator','api',1,'enabled');
INSERT INTO templates(id,name,type,subject,body,is_default) VALUES
 (1,'Synthetic stored wrapper','campaign','','<html><body><header>WRAPPER-STORED</header>{{ template "content" . }}<footer>STORED-END</footer></body></html>',true),
 (2,'Synthetic override wrapper','campaign','','<html><body><header>WRAPPER-OVERRIDE</header>{{ template "content" . }}<footer>OVERRIDE-END</footer></body></html>',false),
 (3,'Synthetic external TX','tx','Stored TX subject','<html><body><p>TX-ONLY {{ .Tx.Data.marker }}</p><p>identity[{{ .Subscriber.UUID }}]name[{{ .Subscriber.Name }}]</p><a href="{{ .Tx.Data.url }}">Local destination</a></body></html>',false);
INSERT INTO lists(id,uuid,name,type,optin) VALUES(1,'20000000-0000-4000-8000-000000000001','Synthetic private list','private','double');
INSERT INTO subscribers(id,uuid,email,name,status) VALUES
 (1,'30000000-0000-4000-8000-000000000001','known@example.invalid','Synthetic known','enabled'),
 (2,'30000000-0000-4000-8000-000000000002','blocked@example.invalid','Synthetic blocked','blocklisted'),
 (3,'30000000-0000-4000-8000-000000000003','unsubscribed@example.invalid','Synthetic unsubscribed','enabled');
INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(1,1,'confirmed'),(2,1,'confirmed'),(3,1,'unsubscribed');
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,messenger,template_id)
 VALUES(1,'40000000-0000-4000-8000-000000000001','Synthetic campaign','Stored campaign subject','Probe <probe@example.invalid>',
 '<p>STORED-BODY</p>','html','draft','email',1);
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(1,1,'Synthetic private list');
