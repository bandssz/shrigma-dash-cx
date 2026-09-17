'use strict';
function includeOlivasEmailListing(source) {
 const old="if(brand&&!WABA[brand])return [out(422,{erro:'marca_invalida'})];";
 if(source.split(old).length!==2)throw Error('Unexpected email listing contract');
 return source.replace(old,"if(brand&&!['fish','aristo','olivas'].includes(brand))return [out(422,{erro:'marca_invalida'})];");
}
module.exports={includeOlivasEmailListing};
